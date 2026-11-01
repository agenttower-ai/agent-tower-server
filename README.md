# AgentTower Server

AgentTower 独立 Node.js 中转服务，采用 [MIT + 标识保留补充条款](LICENSE) 自定义许可。允许商用、修改和分发，不要求公开业务源码或修改代码；必须保留版权、完整许可及服务标识中已有的 AgentTower 来源信息，可并列添加自己的产品名称。这不是标准 MIT 许可。

在 Connector 和兼容的控制客户端之间转发设备状态、会话数据和受支持的操作。

本仓库包含服务端源码、内置管理界面、测试和空白内容配置。生产部署脚本、服务器地址、账号、数据和凭证不包含在内。

## 本地运行与验证

需要 Node.js 20 或以上版本，在仓库根目录运行：

```sh
npm ci --omit=dev
npm start
```

默认监听 `127.0.0.1:17655`，健康检查为 `http://127.0.0.1:17655/health`。持久化数据默认写入当前工作目录的 `data/`。

```sh
node --test tests/*.test.cjs
```

## 可选运行参数

通过进程环境变量设置；服务不自动读取 `.env` 文件。

| 变量 | 用途 |
| --- | --- |
| `HOST` / `PORT` | 本机监听地址和端口 |
| `AGENTTOWER_DEVICE_STORE` | 设备持久化文件路径 |
| `AGENTTOWER_MOBILE_STORE` | 手机持久化文件路径 |
| `AGENTTOWER_WEB_ORIGIN` | Web 客户端允许的准确来源 |
| `AGENTTOWER_ADMIN_USERNAME` / `AGENTTOWER_ADMIN_PASSWORD` | 可选管理后台独立凭证，未配置时禁用 |

新客户端使用独立安装凭证与一次性绑定码，不需要共享 App Key。公告与项目链接配置默认为空。Agent 列表不含品牌图片。

自托管需自行配置 HTTPS/WSS，并使用连接相同服务的 Connector 和兼容客户端。本仓库不含手机客户端。

没有端到端加密，服务端可以读取转发内容。保护持久化文件，其中包含设备、手机关系及运维元数据。内存中的事件不是持久化审计日志。不要提交运行数据、真实日志、生产配置或凭证。

第三方依赖参见 [THIRD_PARTY.md](THIRD_PARTY.md)。
