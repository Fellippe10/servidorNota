const { SignedXml } = require('xml-crypto');

function CustomKeyInfoProvider(certificate) {
    this.getKeyInfo = function (key, prefix) {
        prefix = prefix || '';
        prefix = prefix ? prefix + ':' : prefix;
        // Limpar o certificado para deixar só o Base64 sem os cabeçalhos
        const certBody = certificate
            .replace(/-----BEGIN CERTIFICATE-----/g, '')
            .replace(/-----END CERTIFICATE-----/g, '')
            .replace(/\r?\n|\r/g, '');

        return `<${prefix}X509Data><${prefix}X509Certificate>${certBody}</${prefix}X509Certificate></${prefix}X509Data>`;
    };
    this.getKey = function (keyInfo) {
        return null; // Apenas usado na validação
    };
}

/**
 * Assina digitalmente um XML no padrão exigido pelo Governo (ICP-Brasil).
 * @param {string} xml - O XML original (ex: <DPS>...</DPS>)
 * @param {string} privateKey - Chave privada em PEM
 * @param {string} certificate - Certificado em PEM
 * @param {string} referenceId - O valor do atributo Id da tag que será assinada (ex: Id="DPS123")
 * @returns {string} XML assinado
 */
function assinarXML(xml, privateKey, certificate, referenceId) {
    const sig = new SignedXml();
    // A referência usa XPath buscando o atributo Id
    sig.addReference({
        xpath: `//*[@Id="${referenceId}"]`,
        transforms: [
            'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
            'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
        ],
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256'
    });
    
    sig.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
    sig.signingKey = privateKey;
    sig.keyInfoProvider = new CustomKeyInfoProvider(certificate);
    
    sig.computeSignature(xml);
    return sig.getSignedXml();
}

module.exports = { assinarXML };
