FROM node:20-alpine

# smbclient for reliable SMB testing & browsing via CLI
RUN apk add --no-cache samba-client

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .

RUN mkdir -p /data

EXPOSE 3001
CMD ["node", "server.js"]
