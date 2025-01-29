FROM oven/bun:latest

COPY ./package.json ./bun.lock ./index.ts ./

RUN bun i

CMD [ "bun", "run", "index.ts" ]