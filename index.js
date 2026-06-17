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

        // O token master configurado no .env da conta
        const focusToken = process.env.FOCUS_NFE_API_TOKEN;
        if (!focusToken) {
            return res.status(500).json({ error: 'FOCUS_NFE_API_TOKEN não configurado no servidor' });
        }

        // Determina ambiente da Focus
        const ambiente = process.env.AMBIENTE || 'homologacao';
        const baseUrl = ambiente === 'producao' 
            ? 'https://api.focusnfe.com.br' 
            : 'https://homologacao.focusnfe.com.br';

        // 1. Normalmente, você bateria no Supabase para pegar o CNPJ usando o estabelecimento_id.
        // Aqui usaremos a variável local provisoriamente ou simularemos para MVP.
        const cnpjEmissor = process.env.CNPJ_EMISSOR ? process.env.CNPJ_EMISSOR.replace(/\D/g, '') : '66603175000100';

        // 2. Montar o Payload (Padrão Focus NFe que será mapeado para o Nacional)
        const dpsRef = `DPS_${Date.now()}`; // Referência única para a Focus

        // Preparar datas (Fuso Horário BR)
        const now = new Date(Date.now());
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
                item_lista_servico: "060101", // Código Nacional (Barbearia/Estética)
                valor_servicos: parseFloat(valor),
                iss_retido: false
            }
        };

        // Adiciona dados do Tomador (Cliente) se existir
        if (cpf_cnpj && cliente) {
            const cleanDoc = cpf_cnpj.replace(/\D/g, '');
            payload.tomador = {
                razao_social: cliente
            };
            if (cleanDoc.length === 11) {
                payload.tomador.cpf = cleanDoc;
            } else if (cleanDoc.length === 14) {
                payload.tomador.cnpj = cleanDoc;
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
        const errorData = error.response ? error.response.data : error.message;
        console.error('[FOCUS ERRO]', JSON.stringify(errorData));
        return res.status(error.response ? error.response.status : 500).json({
            error: 'Erro na API da Focus NFe',
            detalhes: errorData
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
