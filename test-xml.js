const axios = require('axios');
const xml = `<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">
  <infDPS Id="DPS330330226660317500010070000000000000000001">
    <tpAmb>1</tpAmb>
    <dhEmi>2026-06-15T10:00:00-03:00</dhEmi>
    <verAplic>EmissorWeb_1.6.0.0</verAplic>
    <dCompet>2026-06-15</dCompet>
    <stat>1</stat>
    <prest>
      <CNPJ>66603175000100</CNPJ>
      <regTrib>
        <opSimpNac>3</opSimpNac>
        <regApTribSN>1</regApTribSN>
        <regEspTrib>0</regEspTrib>
      </regTrib>
    </prest>
    <serv>
      <locPrest>
        <cLocPrestacao>3303302</cLocPrestacao>
      </locPrest>
      <cServ>
        <cTribNac>010101</cTribNac>
        <cTribMun>001</cTribMun>
        <xDescServ>teste</xDescServ>
        <cNBS>111032100</cNBS>
      </cServ>
    </serv>
    <valores>
      <vServPrest>
        <vServ>50.00</vServ>
      </vServPrest>
      <trib>
        <tribMun>
          <tribISSQN>1</tribISSQN>
          <tpRetISSQN>1</tpRetISSQN>
        </tribMun>
        <totTrib>
          <pTotTribSN>6.00</pTotTribSN>
        </totTrib>
      </trib>
    </valores>
  </infDPS>
</DPS>`;

axios.post('https://homologacao.focusnfe.com.br/v2/nfsen?ref=teste-nfsen-5', xml, {
  headers: { 'Content-Type': 'application/xml' },
  auth: { username: '14ziuWMjzbmViciHHEKUwxUDlXvugJz3', password: '' }
})
.then(() => console.log('success'))
.catch(e => console.log(JSON.stringify(e.response?.data || e.message, null, 2)));
