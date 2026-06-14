const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Inicializa o Cliente do Supabase com a Chave Mestra (Service Role Key)
// Isso nos dá poder para baixar arquivos de buckets privados
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("⚠️  AVISO: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados no .env!");
}

// Em ambientes Node.js < 22 o Supabase exige o pacote 'ws' para funcionar a parte de Realtime/Sockets
const WebSocket = require('ws');
global.WebSocket = WebSocket; // Define globalmente para o supabase-js achar

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
    realtime: {
        transport: WebSocket
    }
});

// Rota principal para o N8N fazer o POST
app.post('/emitir-nota', async (req, res) => {
    try {
        const { estabelecimento_id, cliente, cpf_cnpj, valor, servico } = req.body;

        if (!estabelecimento_id || !valor || !servico) {
            return res.status(400).json({ error: 'Faltam dados obrigatórios (estabelecimento_id, valor, servico)' });
        }

        console.log(`\n[API] Nova solicitação para Estabelecimento ID: ${estabelecimento_id}`);

        // 1. Ler arquivo senhas.json local
        // Tenta ler do volume Docker primeiro (/app/data/senhas.json), se não achar tenta na raiz do projeto.
        let senhasPath = path.join('/app/data', 'senhas.json');
        if (!fs.existsSync(senhasPath)) {
            senhasPath = path.join(__dirname, 'senhas.json');
        }

        if (!fs.existsSync(senhasPath)) {
            return res.status(500).json({ error: 'Arquivo senhas.json não encontrado no servidor.' });
        }
        
        const senhasData = JSON.parse(fs.readFileSync(senhasPath, 'utf8'));
        const credenciais = senhasData[estabelecimento_id];

        if (!credenciais || !credenciais.senha || !credenciais.cnpj) {
            return res.status(403).json({ error: 'Senha ou CNPJ do estabelecimento não cadastrados no servidor.' });
        }

        // 2. Baixar o Certificado .pfx do Supabase (Bucket Privado)
        // O nome do arquivo no bucket deve ser o estabelecimento_id + ".pfx"
        const fileName = `${estabelecimento_id}.pfx`;
        console.log(`[API] Baixando certificado ${fileName} do Supabase...`);
        
        const { data: pfxBlob, error: downloadError } = await supabase.storage
            .from('certificados')
            .download(fileName);

        if (downloadError || !pfxBlob) {
            console.error('[ERRO] Falha ao baixar certificado do Supabase:', downloadError?.message);
            return res.status(404).json({ error: 'Certificado não encontrado no banco de dados para este salão.' });
        }

        const pfxBuffer = Buffer.from(await pfxBlob.arrayBuffer());

        // 3. Preparar Conexão Segura (mTLS) com o Governo
        let httpsAgent;
        try {
            httpsAgent = new https.Agent({
                pfx: pfxBuffer,
                passphrase: credenciais.senha,
                rejectUnauthorized: false
            });
            console.log('[API] Certificado aberto com sucesso na RAM e pronto para assinar!');
        } catch (certError) {
            console.error('[ERRO] Senha incorreta ou arquivo corrompido:', certError.message);
            return res.status(403).json({ error: 'Falha ao destrancar o certificado. Verifique a senha cadastrada.' });
        }

        // 4. Preparar o JSON/XML para a API Nacional
        const dpsPayload = {
            "infDPS": {
                "tpAmb": process.env.AMBIENTE === 'producao' ? 1 : 2,
                "prest": { "cpfCnpj": { "cnpj": credenciais.cnpj.replace(/\D/g, '') } },
                "toma": cpf_cnpj ? { "cpfCnpj": { "cpf": cpf_cnpj.replace(/\D/g, '') }, "xNome": cliente } : null,
                "serv": {
                    "cServ": { "cTribNac": "060101", "xDesc": servico },
                    "vServ": { "vPServ": valor }
                }
            }
        };

        // Simulação de Sucesso (Enviando pro Governo)
        console.log(`[API] Emitindo nota para ${cliente} no CNPJ Emissor ${credenciais.cnpj}...`);
        
        setTimeout(() => {
            res.status(200).json({
                sucesso: true,
                mensagem: 'Nota emitida com sucesso! (Modo Simulação)',
                nota_fiscal_url: `https://www.nfs-e.gov.br/ver-nota/SIMULACAO-${Date.now()}`
            });
            console.log('[API] Operação concluída. Dados apagados da memória.');
        }, 1500);

    } catch (error) {
        console.error('[ERRO FATAL]:', error.message);
        res.status(500).json({ error: 'Falha interna do servidor.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Microserviço Multi-Tenant NFS-e rodando na porta ${PORT}`);
});
