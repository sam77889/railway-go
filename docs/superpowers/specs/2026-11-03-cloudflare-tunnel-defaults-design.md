# Cloudflare Tunnel 默认变量设计

## 目标

为固定 Cloudflare Tunnel 提供开箱即用的域名和 Token 默认值，同时保留 Railway 环境变量覆盖默认值的能力。

## 变更范围

- `template.json`：为 `CLOUDFLARE_TUNNEL_DOMAIN` 和 `CLOUDFLARE_TUNNEL_TOKEN` 设置用户指定的默认值。
- `start.sh`：当对应环境变量未设置或为空时，使用相同默认值；显式环境变量始终优先。
- 不在 `.env.example`、README 或新增日志中重复真实 Token。

## 配置优先级

```text
Railway/进程环境变量（非空） > start.sh 内置默认值
```

Railway 模板创建服务时会预填相同值，因此模板部署和直接运行脚本的默认行为保持一致。

## 安全边界

Token 将以明文形式进入版本库。任何能够读取仓库的人都可能使用该 Token 连接对应 Cloudflare Tunnel，因此仓库应保持私有；发生非预期暴露时需要在 Cloudflare 侧轮换 Token。

## 验证

1. `template.json` 能被 JSON 解析器正常读取。
2. `start.sh` 通过 Shell 语法检查。
3. 未提供变量时，脚本选用内置域名和 Token。
4. 提供非空环境变量时，显式值覆盖内置默认值。
