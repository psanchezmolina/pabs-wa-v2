# Usa nodo LTS slim
FROM node:20-alpine

# Directorio de la app
WORKDIR /usr/src/app

# Copiar package.json y package-lock.json
COPY package.json package-lock.json ./

# Instalar dependencias
RUN npm ci --production

# Copiar el resto del código
COPY . .

# Puerto
EXPOSE 3000

# Comando de arranque
CMD ["npm", "start"]
