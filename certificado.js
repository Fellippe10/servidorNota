const fs = require('fs');
const forge = require('node-forge');

/**
 * Lê um arquivo .pfx (PKCS#12) e extrai a chave privada e o certificado em formato PEM
 * @param {string} pfxPath - Caminho para o arquivo .pfx (ou base64 se preferir)
 * @param {string} password - Senha do certificado
 * @returns {{ privateKey: string, certificate: string, p12Buffer: Buffer }}
 */
function extractPemFromPfx(pfxPath, password) {
    if (!fs.existsSync(pfxPath)) {
        throw new Error(`Arquivo de certificado não encontrado em: ${pfxPath}`);
    }

    const p12Buffer = fs.readFileSync(pfxPath);
    // Convert to base64 for node-forge
    const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

    let privateKeyForge = null;
    let certForge = null;
    let certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    let keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });

    // Se a chave não for "shrouded"
    if (!keyBags || keyBags[forge.pki.oids.pkcs8ShroudedKeyBag].length === 0) {
        keyBags = p12.getBags({ bagType: forge.pki.oids.keyBag });
        if (keyBags && keyBags[forge.pki.oids.keyBag].length > 0) {
            privateKeyForge = keyBags[forge.pki.oids.keyBag][0].key;
        }
    } else {
        privateKeyForge = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0].key;
    }

    if (certBags && certBags[forge.pki.oids.certBag].length > 0) {
        // Encontrar o certificado do usuário (ignorando cadeias de CA)
        certForge = certBags[forge.pki.oids.certBag].find(bag => 
            bag.cert.extensions && 
            bag.cert.extensions.some(ext => ext.name === 'keyUsage')
        )?.cert || certBags[forge.pki.oids.certBag][0].cert;
    }

    if (!privateKeyForge || !certForge) {
        throw new Error('Não foi possível extrair a chave privada ou o certificado do arquivo .pfx');
    }

    const privateKey = forge.pki.privateKeyToPem(privateKeyForge);
    const certificate = forge.pki.certificateToPem(certForge);

    return { privateKey, certificate, p12Buffer };
}

module.exports = { extractPemFromPfx };
