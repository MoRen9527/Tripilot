FROM node:20-bookworm-slim

WORKDIR /workspace

COPY package*.json ./
RUN npm ci

COPY . .

CMD ["npm", "run", "test:coverage"]
