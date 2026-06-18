const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Mercado Pago SDK
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN || '' });

// ROTA: Criar Preferência de Pagamento (Mercado Pago)
app.post('/create-preference', async (req, res) => {
    try {
        const { title, amount, quantity, back_url } = req.body;
        const preference = new Preference(mpClient);
        const result = await preference.create({
            body: {
                items: [{
                    title: title || 'Agendamento Barbearia',
                    quantity: quantity || 1,
                    unit_price: Number(amount),
                    currency_id: 'BRL',
                }],
                payment_methods: {
                    excluded_payment_types: [],
                    installments: 1,
                },
            }
        });
        res.json({ id: result.id, init_point: result.init_point, sandbox_init_point: result.sandbox_init_point });
    } catch (e) {
        console.error('[MP ERRO]', e.message);
        res.status(400).json({ error: e.message });
    }
});

// ROTA: Processar Pagamento (Checkout Transparente / Bricks)
app.post('/process-payment', async (req, res) => {
    try {
        const { token, issuer_id, payment_method_id, transaction_amount, installments, payer, description } = req.body;
        
        const payment = new Payment(mpClient);
        const result = await payment.create({
            body: {
                token,
                issuer_id,
                payment_method_id,
                transaction_amount: Number(transaction_amount),
                installments: Number(installments) || 1,
                description: description || 'Agendamento Barbearia',
                payer: {
                    email: payer?.email,
                    identification: payer?.identification,
                },
            }
        });

        console.log(`[MP] Pagamento criado: ${result.id} - Status: ${result.status}`);
        res.json({
            id: result.id,
            status: result.status,
            status_detail: result.status_detail,
            payment_method_id: result.payment_method_id,
            // Dados para Pix (QR Code)
            point_of_interaction: result.point_of_interaction,
        });
    } catch (e) {
        console.error('[MP PAGAMENTO ERRO]', e.message);
        res.status(400).json({ error: e.message });
    }
});

// ROTA: Verificar status do pagamento (para polling do Pix)
app.get('/payment-status/:id', async (req, res) => {
    try {
        const payment = new Payment(mpClient);
        const result = await payment.get({ id: req.params.id });
        res.json({
            id: result.id,
            status: result.status,
            status_detail: result.status_detail,
        });
    } catch (e) {
        console.error('[MP STATUS ERRO]', e.message);
        res.status(400).json({ error: e.message });
    }
});

// WEBHOOK: Receber notificações do Mercado Pago
app.post('/webhook/mercadopago', async (req, res) => {
    try {
        const { type, data } = req.body;
        if (type === 'payment') {
            const payment = new Payment(mpClient);
            const paymentData = await payment.get({ id: data.id });
            console.log(`[MP] Pagamento ${paymentData.id} - Status: ${paymentData.status}`);
            if (paymentData.status === 'approved') {
                console.log('✅ Pagamento aprovado via Mercado Pago!', paymentData.id);
                // TODO: Atualizar Supabase (Agendamento -> Status 'pago')
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('[MP WEBHOOK ERRO]', e.message);
        res.sendStatus(500);
    }
});

// ==========================================
// INTEGRAÇÃO FOCUS NFE (MÓDULO DE NOTAS FISCAIS)
// ==========================================
const axios = require('axios');

app.post('/focus/emitir-nota', async (req, res) => {
    try {
        const { estabelecimento_id, cliente, cpf_cnpj, valor, servico } = req.body;

        if (!estabelecimento_id || !valor || !servico) {
            return res.status(400).json({ error: 'Faltam dados obrigatórios (estabelecimento_id, valor, servico)' });
        }

        console.log(`[FOCUS] Nova solicitação de nota. Estabelecimento: ${estabelecimento_id}`);

        const focusToken = process.env.FOCUS_NFE_API_TOKEN ? process.env.FOCUS_NFE_API_TOKEN.replace(/['"]/g, '').trim() : null;
        const ambiente = process.env.AMBIENTE || 'homologacao';
        const cnpjEmissor = process.env.CNPJ_EMISSOR ? process.env.CNPJ_EMISSOR.replace(/\D/g, '') : '66603175000100';

        if (!focusToken) {
            console.error("[ERRO FATAL] FOCUS_NFE_API_TOKEN não está definido nas variáveis de ambiente!");
            return res.status(500).json({ error: "Erro interno: Token da Focus NFe não configurado no servidor (variável FOCUS_NFE_API_TOKEN vazia)." });
        }

        // 1. Configurar Base URL (Homologação ou Produção)
        const baseUrl = ambiente === 'producao' 
            ? 'https://api.focusnfe.com.br' 
            : 'https://homologacao.focusnfe.com.br';

        // 1. Normalmente, você bateria no Supabase para pegar o CNPJ usando o estabelecimento_id.
        // Aqui usaremos a variável local provisoriamente ou simularemos para MVP.

        // 2. Montar o Payload (Padrão Focus NFe que será mapeado para o Nacional)
        const dpsRef = `DPS_${Date.now()}`; // Referência única para a Focus

        // Preparar datas (Fuso Horário BR) e voltar 2 minutos para evitar erro E0008 (relógio adiantado)
        const now = new Date(Date.now() - (2 * 60 * 1000));
        const pad = (n) => String(n).padStart(2, '0');
        const brHours = now.getUTCHours() - 3;
        const brDate = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
            brHours, now.getUTCMinutes(), now.getUTCSeconds()
        ));
        const dataEmissao = `${brDate.getUTCFullYear()}-${pad(brDate.getUTCMonth()+1)}-${pad(brDate.getUTCDate())}T${pad(brDate.getUTCHours())}:${pad(brDate.getUTCMinutes())}:${pad(brDate.getUTCSeconds())}-03:00`;

        const payload = {
            data_emissao: dataEmissao,
            natureza_operacao: "1", // 1 - Tributação no município
            prestador: {
                cnpj: cnpjEmissor,
                codigo_municipio: "3303302" // Niterói
            },
            servico: {
                aliquota: 2, // Alíquota do ISS (Ajuste conforme a ME)
                discriminacao: servico,
                item_lista_servico: "010101", // Código Nacional (Análise e Desenv. de Sistemas)
                codigo_tributacao_municipal_iss: "001", // Código Tributário Municipal de Niterói
                codigo_cnae: "6201501", // CNAE do Prestador
                valor_servicos: parseFloat(valor),
                iss_retido: false
            }
        };

        // Helper para validar CPF e CNPJ matematicamente (evita erro E0188 no Sefin)
        const isValidCPF = (cpf) => {
            if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
            let sum = 0, rest;
            for (let i = 1; i <= 9; i++) sum = sum + parseInt(cpf.substring(i-1, i)) * (11 - i);
            rest = (sum * 10) % 11;
            if ((rest === 10) || (rest === 11)) rest = 0;
            if (rest !== parseInt(cpf.substring(9, 10))) return false;
            sum = 0;
            for (let i = 1; i <= 10; i++) sum = sum + parseInt(cpf.substring(i-1, i)) * (12 - i);
            rest = (sum * 10) % 11;
            if ((rest === 10) || (rest === 11)) rest = 0;
            if (rest !== parseInt(cpf.substring(10, 11))) return false;
            return true;
        };

        const isValidCNPJ = (cnpj) => {
            if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
            let size = cnpj.length - 2;
            let numbers = cnpj.substring(0, size);
            const digits = cnpj.substring(size);
            let sum = 0;
            let pos = size - 7;
            for (let i = size; i >= 1; i--) {
                sum += numbers.charAt(size - i) * pos--;
                if (pos < 2) pos = 9;
            }
            let result = sum % 11 < 2 ? 0 : 11 - sum % 11;
            if (result !== parseInt(digits.charAt(0))) return false;
            size = size + 1;
            numbers = cnpj.substring(0, size);
            sum = 0;
            pos = size - 7;
            for (let i = size; i >= 1; i--) {
                sum += numbers.charAt(size - i) * pos--;
                if (pos < 2) pos = 9;
            }
            result = sum % 11 < 2 ? 0 : 11 - sum % 11;
            if (result !== parseInt(digits.charAt(1))) return false;
            return true;
        };

        // Adiciona dados do Tomador (Cliente) se existir e for válido
        if (cpf_cnpj && cliente) {
            const cleanDoc = cpf_cnpj.replace(/\D/g, '');
            
            if (cleanDoc.length === 11 && isValidCPF(cleanDoc)) {
                payload.tomador = {
                    razao_social: cliente,
                    cpf: cleanDoc
                };
            } else if (cleanDoc.length === 14 && isValidCNPJ(cleanDoc)) {
                payload.tomador = {
                    razao_social: cliente,
                    cnpj: cleanDoc
                };
            } else {
                console.log(`[FOCUS] CPF/CNPJ inválido (${cleanDoc}) recebido. Emitindo sem tomador explícito.`);
                // Como a Focus exige CPF/CNPJ se o bloco 'tomador' existir, 
                // removemos o bloco e colocamos o nome do cliente na descrição do serviço.
                payload.servico.discriminacao += `\nCliente: ${cliente}`;
            }
        }

        console.log(`[FOCUS] Enviando JSON para Focus NFe (${baseUrl}/v2/nfse)...`);

        // 3. Fazer o POST para a Focus NFe
        const response = await axios.post(`${baseUrl}/v2/nfse?ref=${dpsRef}`, payload, {
            auth: {
                username: focusToken,
                password: '' // A API da Focus usa o token como username e senha vazia no Basic Auth
            }
        });

        console.log('[FOCUS] Sucesso! Nota enviada para fila:', response.data);

        return res.status(200).json({
            sucesso: true,
            mensagem: 'Nota enviada com sucesso para a Focus NFe',
            dados_focus: response.data,
            referencia: dpsRef
        });

    } catch (error) {
        // Se houver erro de requisição ou retorno com erro da Focus
        console.error("[ERRO SEFIN]:", error.response?.data || error.message);

        return res.status(400).json({ 
            error: 'Erro na API da Focus NFe',
            detalhes: error.response?.data || error.message,
            debugInfo: "Ocorreu uma falha no envio, possivelmente o token está formatado incorretamente nas aspas duplas."
        });
    }
});

app.post('/focus/webhook', async (req, res) => {
    try {
        console.log('[FOCUS WEBHOOK] Nova atualização recebida:', JSON.stringify(req.body));
        // TODO: Mapear para o Supabase usando o req.body.ref (referência da DPS)
        res.status(200).send('OK');
    } catch (e) {
        console.error('[FOCUS WEBHOOK ERRO]', e.message);
        res.status(500).send('Erro');
    }
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
    console.log(`🚀 Microserviço de Pagamentos e Notas Fiscais rodando na porta ${PORT}`);
});
