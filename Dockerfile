FROM node:20-bullseye

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install
RUN python3 -m pip install pytrends

COPY . .

ENV SEO_HUB_PORT=3001
EXPOSE 3001

CMD ["npm", "run", "start:ui"]
