FROM oven/bun:latest

ADD https://github.com/NiXtheDev/AGBday-bot.git /bot
WORKDIR /bot
RUN bun i

CMD [ "bun", "run", "index.ts" ]