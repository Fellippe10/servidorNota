const { SignedXml } = require('xml-crypto');

/**
 * Assina digitalmente um XML no padrão exigido pelo Governo (ICP-Brasil).
 * @param {string} xml - O XML original (ex: <DPS>...</DPS>)
 * @param {string} privateKey - Chave privada em PEM
 * @param {string} certificate - Certificado em PEM
 * @param {string} referenceId - O valor do atributo Id da tag que será assinada (ex: Id="DPS123")
 * @returns {string} XML assinado
 */
function assinarXML(xml, privateKey, certificate, referenceId) {
    const sig = new SignedXml({
        privateKey: privateKey,
        publicCert: certificate,
        signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
    });
    // A referência usa XPath buscando o atributo Id
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

module.exports = { assinarXML };
