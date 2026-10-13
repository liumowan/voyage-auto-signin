# Zeabur 部署用：容器内跑 crond，每天定点签到一次
FROM node:20-alpine

RUN apk add --no-cache dcron

WORKDIR /app
COPY signin.mjs discover.mjs sessions.mjs package.json ./
COPY lib/ ./lib/

# 时区按签到基准（脚本内部用 VOYAGE_TZ 计算“今天”）
ENV TZ=Asia/Shanghai

# 运行时文件必须落在挂载卷上，否则容器一重建就全丢：
#   .auth.json   各账号登录态  → 丢了会每天重新登录一次，
#                 而该站每登录一次就在「登录设备」里多堆一条记录
#   .site.json   站点级 action id → 丢了每个账号都要重扫十几个 JS chunk
#   state.*.json 各账号签到状态（按账号隔离）
ENV VOYAGE_DATA_DIR=/data
VOLUME /data

RUN printf '%s\n' \
  '30 9 * * * cd /app && node signin.mjs >> /var/log/signin.log 2>&1' \
  > /var/spool/cron/crontabs/root \
  && chmod 0600 /var/spool/cron/crontabs/root

# 前台运行 crond，方便 Zeabur 管理容器生命周期
CMD ["crond", "-f", "-l", "0", "-L", "/var/log/cron.log"]
