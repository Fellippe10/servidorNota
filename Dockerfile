FROM node:20-alpine

# Cria a pasta de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de configuração do Node
COPY package*.json ./

# Instala as dependências
RUN npm install --production

# Copia todo o resto do código (incluindo o index.js e o CERTIFICADO.pfx)
COPY . .

# Expõe a porta que configuramos no Express
EXPOSE 3000

# Comando para iniciar o servidor
CMD ["node", "index.js"]
