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
        const nDPS = Math.floor(Math.random() * 999999999) + 1; // Número sequencial da DPS
        const nDPSStr = String(nDPS).padStart(15, '0');
        const cMunEmi = '3303302'; // Código do município de emissão
        const tpInscFed = '2'; // 2 = CNPJ
        const serieStr = '00001';
        const cnpjPuro = credenciais.cnpj.replace(/\D/g, '').padStart(14, '0');
        
        // Padrão Sefin Nacional: DPS(3) + cMunEmi(7) + tpInsc(1) + CNPJ(14) + serie(5) + numero(15) = 45 posições
        const dpsId = `DPS${cMunEmi}${tpInscFed}${cnpjPuro}${serieStr}${nDPSStr}`;

        // Gerar data/hora no fuso de Brasília (-03:00) corretamente
        // Subtrair 1 minuto de segurança para evitar rejeição por diferença de relógio
        const now = new Date(Date.now() - 60000);
        const pad = (n) => String(n).padStart(2, '0');
        // Converter UTC para Brasília manualmente
        const brHours = now.getUTCHours() - 3;
        const brDate = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
            brHours, now.getUTCMinutes(), now.getUTCSeconds()
        ));
        const dataEmissao = `${brDate.getUTCFullYear()}-${pad(brDate.getUTCMonth()+1)}-${pad(brDate.getUTCDate())}T${pad(brDate.getUTCHours())}:${pad(brDate.getUTCMinutes())}:${pad(brDate.getUTCSeconds())}-03:00`;
        const dataCompetencia = `${brDate.getUTCFullYear()}-${pad(brDate.getUTCMonth()+1)}-${pad(brDate.getUTCDate())}`;

        let xmlDPS = `<?xml version="1.0" encoding="UTF-8"?>
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">
  <infDPS Id="${dpsId}">
    <tpAmb>${ambienteId}</tpAmb>
    <dhEmi>${dataEmissao}</dhEmi>
    <verAplic>MeuSalao_1.0</verAplic>
    <serie>1</serie>
    <nDPS>${nDPS}</nDPS>
    <dCompet>${dataCompetencia}</dCompet>
    <tpEmit>1</tpEmit>
    <cLocEmi>3303302</cLocEmi>
    <prest>
      <CNPJ>${credenciais.cnpj.replace(/\D/g, '')}</CNPJ>
      <regTrib>
        <opSimpNac>1</opSimpNac>
        <regApTribSN>1</regApTribSN>
        <regEspTrib>0</regEspTrib>
      </regTrib>
    </prest>
    ${cpf_cnpj ? (() => {
      const cleanDoc = cpf_cnpj.replace(/\D/g, '');
      const docTag = cleanDoc.length === 14 ? 'CNPJ' : 'CPF';
      return `<toma>
      <${docTag}>${cleanDoc}</${docTag}>
      <xNome>${cliente}</xNome>
    </toma>`;
    })() : ''}
    <serv>
      <locPrest>
        <cLocPrestacao>3303302</cLocPrestacao>
      </locPrest>
      <cServ>
        <cTribNac>010401</cTribNac>
        <cTribMun>00000000000000010400</cTribMun>
        <xDescServ>${servico}</xDescServ>
      </cServ>
    </serv>
    <valores>
      <vServPrest>
        <vServ>${parseFloat(valor).toFixed(2)}</vServ>
      </vServPrest>
      <trib>
        <tribMun>
          <tribISSQN>1</tribISSQN>
          <tpRetISSQN>1</tpRetISSQN>
        </tribMun>
        <totTrib>
          <indTotTrib>0</indTotTrib>
        </totTrib>
      </trib>
    </valores>
  </infDPS>
</DPS>`;

        // 5. Assinar XML
        const xmlAssinado = assinarXML(xmlDPS, privateKey, certificate, dpsId);

        console.log(`[API] Enviando nota Nacional para ${cliente} no CNPJ Emissor ${credenciais.cnpj}...`);
        console.log(`[DEBUG] dhEmi gerado: ${dataEmissao} | UTC agora: ${new Date().toISOString()}`);
        
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

app.get('/parametros-municipio/:municipio', async (req, res) => {
    try {
        const { municipio } = req.params;
        const ambiente = req.query.amb || '2';
        const estabelecimento_id = "e53d52ee-8ec9-4bfb-b4c1-b2cd96f349a3";
        const cnpj = "66603175000100";
        
        let senhasPath = path.join('/app/data', 'senhas.json');
        if (!fs.existsSync(senhasPath)) {
            senhasPath = path.join(__dirname, 'senhas.json');
        }
        const senhasStr = fs.readFileSync(senhasPath, 'utf8');
        const senhas = JSON.parse(senhasStr);
        let senhaCertificado = senhas[estabelecimento_id] ? senhas[estabelecimento_id].senha : null;
        if (!senhaCertificado) return res.status(400).json({error: 'Estabelecimento ID não encontrado nas senhas.'});

        // Baixar certificado
        const { data: certData, error: certError } = await supabase.storage.from('certificados').download(`${estabelecimento_id}.pfx`);
        if (certError) throw certError;

        const certBuffer = Buffer.from(await certData.arrayBuffer());
        const tempPfxPath = path.join(__dirname, `temp_cert_${Date.now()}.pfx`);
        fs.writeFileSync(tempPfxPath, certBuffer);

        const { extractPemFromPfx } = require('./certificado');
        const { certificate, privateKey } = extractPemFromPfx(tempPfxPath, senhaCertificado);
        fs.unlinkSync(tempPfxPath);

        const httpsAgent = new https.Agent({ cert: certificate, key: privateKey, rejectUnauthorized: false });
        const axios = require('axios');

        const baseUrl = ambiente === '1' 
            ? 'https://adn.nfse.gov.br' 
            : 'https://adn.producaorestrita.nfse.gov.br';

        // Endpoint de convenio
        let respConvenioData = null;
        let statusConvenio = null;
        try {
            const convenioUrl = `${baseUrl}/parametros_municipais/${municipio}/convenio`;
            const respConvenio = await axios.get(convenioUrl, { headers: { 'Accept': 'application/json' }, httpsAgent });
            respConvenioData = respConvenio.data;
            statusConvenio = respConvenio.status;
        } catch (e) {
            respConvenioData = e.response ? e.response.data : e.message;
            statusConvenio = e.response ? e.response.status : 500;
        }

        // Endpoint de servicos para o codigo 010401
        let servicoInfo = null;
        let statusServico = null;
        try {
            const servicoUrl = `${baseUrl}/parametros_municipais/${municipio}/010401`;
            const respServico = await axios.get(servicoUrl, { headers: { 'Accept': 'application/json' }, httpsAgent });
            servicoInfo = respServico.data;
            statusServico = respServico.status;
        } catch (e) {
            servicoInfo = e.response ? e.response.data : e.message;
            statusServico = e.response ? e.response.status : 500;
        }

        res.json({
            ambiente: ambiente === '1' ? 'Producao' : 'Homologacao',
            municipio,
            convenio: { status: statusConvenio, data: respConvenioData },
            servico_010401: { status: statusServico, data: servicoInfo }
        });

    } catch (error) {
        res.status(500).json({
            error: error.message,
            detalhes: error.response?.data || null
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Microserviço Multi-Tenant NFS-e rodando na porta ${PORT}`);
});
