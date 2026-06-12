FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 4000
# Run the TypeScript directly with tsx (no separate compile step).
# This lets the scaffold package and run while features are still being built.
CMD ["npx", "tsx", "src/server.ts"]
