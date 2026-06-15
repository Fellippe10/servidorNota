const { SignedXml } = require('xml-crypto');
const forge = require('node-forge');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">
  <infDPS Id="DPS666031750001001781490976594000000000000000">
    <tpAmb>2</tpAmb>
  </infDPS>
</DPS>`;

// Gerar chaves reais para o teste
const keys = forge.pki.rsa.generateKeyPair(1024);
const certObj = forge.pki.createCertificate();
certObj.publicKey = keys.publicKey;
certObj.sign(keys.privateKey, forge.md.sha256.create());
const pemCert = forge.pki.certificateToPem(certObj);
const pemKey = forge.pki.privateKeyToPem(keys.privateKey);

function assinarXMLTest(xml, privateKey, certificate, referenceId) {
    const sig = new SignedXml({
        privateKey: privateKey,
        publicCert: certificate,
        signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
    });
    sig.addReference({
        xpath: `//*[@Id="${referenceId}"]`,
        transforms: [
            'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
            'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
        ],
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256'
    });
    sig.computeSignature(xml);
    return sig.getSignedXml();
}

const signed = assinarXMLTest(xml, pemKey, pemCert, 'DPS666031750001001781490976594000000000000000');
console.log(signed);
