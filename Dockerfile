FROM node:20-alpine

WORKDIR /app

# Copy and install backend deps
COPY package*.json ./
RUN npm install

# Copy and install + build frontend
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# Copy backend source
COPY . .

RUN mkdir -p auth_info

EXPOSE $PORT

CMD ["node", "src/index.js"]
