FROM node:20-alpine

# Install samba-client for SMB support
RUN apk add --no-cache samba-client

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

RUN mkdir -p /data

EXPOSE 3001
CMD ["node", "server.js"]
