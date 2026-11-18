# 配件大亂鬥 Gear Brawl：雲端部署用（Render 等支援 Docker 的平台）
# 伺服器只用 Python 標準函式庫，不需要安裝任何套件
FROM python:3.12-slim

RUN useradd -m -u 1000 user
USER user
WORKDIR /home/user/app

COPY --chown=user server.py ./
COPY --chown=user public ./public

# 平台會用環境變數 PORT 指定埠號（Render 預設 10000），server.py 會讀它
ENV PORT=10000 PYTHONUNBUFFERED=1
EXPOSE 10000
CMD ["python", "-X", "utf8", "server.py"]
