const axios = require('axios');

const testCases = [
    { codigo_tributacao_municipio: "001" },
    { codigo_tributario_municipio: "001" },
    { codigo_municipio_tributacao: "001" },
    { cTribMun: "001" },
    { codigo_tributacao: "001" }
];

async function run() {
    for (let i = 0; i < testCases.length; i++) {
        try {
            await axios.post(`https://homologacao.focusnfe.com.br/v2/nfse?ref=test-fuzz-mun-${Date.now()}-${i}`, {
                data_emissao: '2026-06-15T10:00:00-03:00',
                natureza_operacao: '1',
                prestador: { cnpj: '66603175000100', codigo_municipio: '3303302' },
                servico: {
                    aliquota: 2, discriminacao: 'teste', item_lista_servico: '010101', 
                    codigo_cnae: '6201501', 
                    valor_servicos: 50, iss_retido: false,
                    ...testCases[i]
                }
            }, { auth: { username: '14ziuWMjzbmViciHHEKUwxUDlXvugJz3', password: '' } });
            
        } catch (e) {
            // ignore post errors
        }
    }
    console.log("Done fuzzing municipal code");
}
run();
