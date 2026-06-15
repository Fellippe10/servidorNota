const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
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

        const { extractPemFromPfx } = require('./certificado');
        const { assinarXML } = require('./xml_signer');
        const axios = require('axios');

        // Extrai a chave privada e certificado do pfxBuffer
        const tempPfxPath = path.join(__dirname, `temp_${Date.now()}.pfx`);
        fs.writeFileSync(tempPfxPath, pfxBuffer);
        
        let privateKey, certificate;
        try {
            const extracted = extractPemFromPfx(tempPfxPath, credenciais.senha);
            privateKey = extracted.privateKey;
            certificate = extracted.certificate;
            fs.unlinkSync(tempPfxPath); // Limpar arquivo
            console.log('[API] Certificado aberto com sucesso na RAM e pronto para assinar!');
        } catch (e) {
            if (fs.existsSync(tempPfxPath)) fs.unlinkSync(tempPfxPath);
            console.error('[ERRO] Falha ao extrair chaves do PFX:', e.message);
            return res.status(403).json({ error: 'Falha ao processar o certificado PFX ou senha incorreta.' });
        }

        // 3. Preparar Conexão Segura (mTLS) com o Governo (usando PEM para fugir do erro de PFX do Node 18+)
        let httpsAgent = new https.Agent({
            cert: certificate,
            key: privateKey,
            rejectUnauthorized: false
        });

        // 4. Preparar o XML da DPS (Padrão Nacional)
        const ambienteId = process.env.AMBIENTE === 'producao' ? 1 : 2;
        const dpsId = `DPS${Date.now()}`;
        const dataEmissao = new Date().toISOString().split('.')[0] + '-03:00'; // Formato esperado

        let xmlDPS = `<?xml version="1.0" encoding="UTF-8"?>
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">
  <infDPS Id="${dpsId}" versao="1.00">
    <tpAmb>${ambienteId}</tpAmb>
    <dhEmi>${dataEmissao}</dhEmi>
    <prest>
      <cpfCnpj>
        <cnpj>${credenciais.cnpj.replace(/\D/g, '')}</cnpj>
      </cpfCnpj>
    </prest>
    <toma>
      ${cpf_cnpj ? `<cpfCnpj><cpf>${cpf_cnpj.replace(/\D/g, '')}</cpf></cpfCnpj><xNome>${cliente}</xNome>` : `<xNome>Consumidor Final</xNome>`}
    </toma>
    <serv>
      <locPrest>
        <cMun>3303302</cMun> <!-- Código IBGE de Niterói -->
      </locPrest>
      <cServ>
        <cTribNac>060101</cTribNac> <!-- Cabeleireiros, manicures, pedicures -->
        <xDesc>${servico}</xDesc>
      </cServ>
      <vServ>
        <vPServ>${parseFloat(valor).toFixed(2)}</vPServ>
      </vServ>
    </serv>
  </infDPS>
</DPS>`;

        // 5. Assinar XML
        const xmlAssinado = assinarXML(xmlDPS, privateKey, certificate, dpsId);

        console.log(`[API] Enviando nota Nacional para ${cliente} no CNPJ Emissor ${credenciais.cnpj}...`);
        
        // 6. Preparar JSON com GZIP e Base64
        const xmlGzipB64 = zlib.gzipSync(Buffer.from(xmlAssinado, 'utf-8')).toString('base64');
        const payloadJson = {
            dpsXmlGZipB64: xmlGzipB64
        };

        // 7. Enviar para a API Nacional via Axios com mTLS
        const sefinUrl = ambienteId === 1 
            ? 'https://sefin.nfse.gov.br/SefinNacional/nfse' 
            : 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse';

        try {
            const response = await axios.post(sefinUrl, payloadJson, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                httpsAgent: httpsAgent
            });

            console.log('[API] Resposta da Sefin:', response.data);

            res.status(200).json({
                sucesso: true,
                mensagem: 'Nota enviada para a API Nacional com sucesso!',
                recibo: response.data,
                // O link da nota oficial geralmente retorna no XML da Sefin. Aqui é um placeholder.
                nota_fiscal_url: `https://www.nfse.gov.br/consultar-nota`
            });
            console.log('[API] Operação concluída.');

        } catch (apiError) {
            const sefinResponse = apiError.response ? apiError.response.data : apiError.message;
            console.error('[ERRO SEFIN]:', JSON.stringify(sefinResponse));
            res.status(502).json({ 
                error: 'Erro na API do Governo', 
                detalhes: sefinResponse 
            });
        }

    } catch (error) {
        console.error('[ERRO FATAL]:', error.message);
        res.status(500).json({ error: 'Falha interna do servidor.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Microserviço Multi-Tenant NFS-e rodando na porta ${PORT}`);
});
