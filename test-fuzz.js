const axios = require('axios');

const testCases = [
    { percentual_total_tributos: 6.0 },
    { percentual_tributos_federais: 6.0 },
    { valor_tributos_federais: 1.0 },
    { percentual_total_tributos_simples_nacional: 6.0 },
    { pTotTribSN: 6.0 },
    { aliquota_simples_nacional: 6.0 },
    { vRetCSLL: 0, vRetPisCofins: 0 },
    { cst_pis: '00', cst_cofins: '00' },
    { valor_pis: 0, valor_cofins: 0 },
    { cst_pis_cofins: '00' }
];

async function run() {
    for (let i = 0; i < testCases.length; i++) {
        try {
            await axios.post(`https://homologacao.focusnfe.com.br/v2/nfse?ref=test-fuzz-ep-${i}`, {
                data_emissao: '2026-06-15T10:00:00-03:00',
                natureza_operacao: '1',
                optante_simples_nacional: 3,
                prestador: { cnpj: '66603175000100', codigo_municipio: '3303302' },
                servico: {
                    aliquota: 2, discriminacao: 'teste', item_lista_servico: '010101', 
                    codigo_tributacao_municipio: '001', codigo_cnae: '6201501', 
                    valor_servicos: 50, iss_retido: false,
                    tributos: testCases[i]
                }
            }, { auth: { username: '14ziuWMjzbmViciHHEKUwxUDlXvugJz3', password: '' } });
            console.log(`Test ${i} SUCCEEDED!`, testCases[i]);
        } catch (e) {
             console.log(`Test ${i} FAILED`, e.response?.data?.mensagem);
        }
    }
    console.log("Done fuzzing tributos");
}
run();
