# 常用厂商配置参考 (Provider Presets)

任意 OpenAI 兼容厂商都可接入 hmharness —— 编辑 `~/.hmharness/config.json`(单厂商)或用 `providers` + `routing` 按用途路由(chat / vision / evolve / bench;未配置的用途回退 chat,vision 再回退主厂商)。密钥只存在本机,下面所有示例的 `apiKey` 都来自各家控制台。

> 资料整理自社区常用厂商模板(38 家,剔除本地网关);型号与价格以各家控制台为准。

## Agnes AI(OpenAI 兼容网关)  控制台: https://agnes-ai.com/  文档: https://wiki.agnes-ai.com/

控制台: https://agnes-ai.com/

```json
{
  "provider": {
    "baseUrl": "https://apihub.agnes-ai.com/v1",
    "apiKey": "sk-...(env: AGNES_API_KEY)",
    "model": "agnes-2.0-flash"
  }
}
```

## 302.AI(国内聚合网关)  控制台: https://302.ai/

控制台: https://302.ai/

```json
{
  "provider": {
    "baseUrl": "https://api.302.ai/v1",
    "apiKey": "sk-...(env: AIGC302_API_KEY)",
    "model": "claude-sonnet-4-5"
  }
}
```
可选型号: claude-sonnet-4-5, gpt-5

## Anthropic 官方(需海外网络)

控制台: https://console.anthropic.com/

```json
{
  "provider": {
    "baseUrl": "https://api.anthropic.com/v1",
    "apiKey": "sk-...(env: ANTHROPIC_API_KEY)",
    "model": "claude-sonnet-4-5"
  }
}
```
可选型号: claude-sonnet-4-5, claude-opus-4-1

## 百川智能  控制台: https://platform.baichuan-ai.com/

控制台: https://platform.baichuan-ai.com/

```json
{
  "provider": {
    "baseUrl": "https://api.baichuan-ai.com/v1",
    "apiKey": "sk-...(env: BAICHUAN_API_KEY)",
    "model": "Baichuan4"
  }
}
```

## 阿里百炼国际版(海外 DashScope)

控制台: https://bailian.console.alibabacloud.com/

```json
{
  "provider": {
    "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "apiKey": "sk-...(env: DASHSCOPE_API_KEY)",
    "model": "qwen3-max"
  }
}
```

## Cerebras(超高速推理)  控制台: https://cloud.cerebras.ai/

控制台: https://cloud.cerebras.ai/

```json
{
  "provider": {
    "baseUrl": "https://api.cerebras.ai/v1",
    "apiKey": "sk-...(env: CEREBRAS_API_KEY)",
    "model": "llama3.3-70b"
  }
}
```
可选型号: llama3.3-70b, qwen-3-235b-a22b-instruct-2507

## 自定义任意 OpenAI 兼容端点(教学模板:复制改名填三处)

```json
{
  "provider": {
    "baseUrl": "https://api.your-provider.com/v1",
    "apiKey": "sk-...(env: CUSTOM_API_KEY)",
    "model": "your-model-id"
  }
}
```

## DeepInfra  控制台: https://deepinfra.com/

控制台: https://deepinfra.com/

```json
{
  "provider": {
    "baseUrl": "https://api.deepinfra.com/v1/openai",
    "apiKey": "sk-...(env: DEEPINFRA_API_KEY)",
    "model": "deepseek-ai/DeepSeek-V3-0324"
  }
}
```

## DeepSeek 官方(按量)

控制台: https://platform.deepseek.com/

```json
{
  "provider": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-...(env: DEEPSEEK_API_KEY)",
    "model": "deepseek-chat"
  }
}
```
可选型号: deepseek-chat, deepseek-reasoner

## 火山方舟豆包(模型 id = 控制台接入点 ep-xxxx,填入 models)

控制台: https://console.volcengine.com/ark

```json
{
  "provider": {
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "apiKey": "sk-...(env: ARK_API_KEY)",
    "model": "ep-xxxxxxxxxxxx"
  }
}
```

## Fireworks AI  控制台: https://fireworks.ai/

控制台: https://fireworks.ai/

```json
{
  "provider": {
    "baseUrl": "https://api.fireworks.ai/inference/v1",
    "apiKey": "sk-...(env: FIREWORKS_API_KEY)",
    "model": "accounts/fireworks/models/deepseek-v3"
  }
}
```

## GLM Coding Plan(智谱订阅套餐,推荐)

控制台: https://bigmodel.cn/

```json
{
  "provider": {
    "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
    "apiKey": "sk-...(env: ZAI_CODING_CN_API_KEY)",
    "model": "glm-5.3"
  }
}
```
可选型号: glm-5.3, glm-5.2

## 智谱按量付费(开放平台通用端点)

控制台: https://open.bigmodel.cn/

```json
{
  "provider": {
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKey": "sk-...(env: ZHIPU_API_KEY)",
    "model": "glm-4.7"
  }
}
```
可选型号: glm-4.7, glm-4.6

## Groq(超低延迟推理)  控制台: https://console.groq.com/

控制台: https://console.groq.com/

```json
{
  "provider": {
    "baseUrl": "https://api.groq.com/openai/v1",
    "apiKey": "sk-...(env: GROQ_API_KEY)",
    "model": "llama-3.3-70b-versatile"
  }
}
```
可选型号: llama-3.3-70b-versatile, qwen/qwen3-32b

## Hugging Face Inference Router  控制台: https://huggingface.co/inference-providers

控制台: https://huggingface.co/inference-providers

```json
{
  "provider": {
    "baseUrl": "https://router.huggingface.co/v1",
    "apiKey": "sk-...(env: HF_TOKEN)",
    "model": "deepseek-ai/DeepSeek-V3-0324"
  }
}
```

## 腾讯混元(OpenAI 兼容)  控制台: https://console.cloud.tencent.com/hunyuan

控制台: https://console.cloud.tencent.com/hunyuan

```json
{
  "provider": {
    "baseUrl": "https://api.hunyuan.cloud.tencent.com/v1",
    "apiKey": "sk-...(env: HUNYUAN_API_KEY)",
    "model": "hunyuan-turbos-latest"
  }
}
```

## 月之暗面 Kimi

控制台: https://platform.moonshot.cn/

```json
{
  "provider": {
    "baseUrl": "https://api.moonshot.cn/v1",
    "apiKey": "sk-...(env: MOONSHOT_API_KEY)",
    "model": "kimi-k2-0905-preview"
  }
}
```
可选型号: kimi-k2-0905-preview, kimi-latest

## MiniMax(海螺)  控制台: https://platform.minimaxi.com/

控制台: https://platform.minimaxi.com/

```json
{
  "provider": {
    "baseUrl": "https://api.minimaxi.com/v1",
    "apiKey": "sk-...(env: MINIMAX_API_KEY)",
    "model": "MiniMax-M2"
  }
}
```

## Mistral AI  控制台: https://console.mistral.ai/

控制台: https://console.mistral.ai/

```json
{
  "provider": {
    "baseUrl": "https://api.mistral.ai/v1",
    "apiKey": "sk-...(env: MISTRAL_API_KEY)",
    "model": "mistral-large-latest"
  }
}
```
可选型号: mistral-large-latest, codestral-latest

## Nebius AI Studio  控制台: https://studio.nebius.ai/

控制台: https://studio.nebius.ai/

```json
{
  "provider": {
    "baseUrl": "https://api.studio.nebius.ai/v1",
    "apiKey": "sk-...(env: NEBIUS_API_KEY)",
    "model": "deepseek-ai/DeepSeek-V3"
  }
}
```

## NVIDIA NIM(build.nvidia.com 在线,或自托管 http://localhost:8000/v1)

```json
{
  "provider": {
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "apiKey": "sk-...(env: NVIDIA_API_KEY)",
    "model": "deepseek-ai/deepseek-r1"
  }
}
```

## OpenAI 官方(需海外网络)

控制台: https://platform.openai.com/

```json
{
  "provider": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...(env: OPENAI_API_KEY)",
    "model": "gpt-5"
  }
}
```
可选型号: gpt-5, gpt-5-mini

## OpenRouter(全球聚合路由)

控制台: https://openrouter.ai/keys

```json
{
  "provider": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKey": "sk-...(env: OPENROUTER_API_KEY)",
    "model": "anthropic/claude-sonnet-4"
  }
}
```
可选型号: anthropic/claude-sonnet-4, openai/gpt-5, deepseek/deepseek-chat

## 阿里通义(百炼兼容模式)

控制台: https://bailian.console.aliyun.com/

```json
{
  "provider": {
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "apiKey": "sk-...(env: DASHSCOPE_API_KEY)",
    "model": "qwen3-max"
  }
}
```
可选型号: qwen3-max, qwen3-coder-plus

## 商汤 SenseNova 日日新(Token Plan 免费端点)  控制台: https://console.sensecore.cn/  兼容模式文档: sensecore.cn/help/docs/model-as-a-service/nova/overview/compatible-mode

控制台: https://console.sensecore.cn/

```json
{
  "provider": {
    "baseUrl": "https://token.sensenova.cn/v1",
    "apiKey": "sk-...(env: SENSENOVA_API_KEY)",
    "model": "sensenova-6.7-flash-lite"
  }
}
```

## 硅基流动(国内聚合)

控制台: https://cloud.siliconflow.cn/

```json
{
  "provider": {
    "baseUrl": "https://api.siliconflow.cn/v1",
    "apiKey": "sk-...(env: SILICONFLOW_API_KEY)",
    "model": "deepseek-ai/DeepSeek-V3.2"
  }
}
```
可选型号: deepseek-ai/DeepSeek-V3.2, Qwen/Qwen3-235B-A22B-Instruct

## 讯飞星火(OpenAI 兼容;用 APIPassword 作 Key)  控制台: https://xinghuo.xfyun.cn/

控制台: https://xinghuo.xfyun.cn/

```json
{
  "provider": {
    "baseUrl": "https://spark-api-open.xf-yun.com/v1",
    "apiKey": "sk-...(env: SPARK_API_PASSWORD)",
    "model": "generalv3.5"
  }
}
```
可选型号: generalv3.5, 4.0Ultra

## 阶跃星辰 StepFun  控制台: https://platform.stepfun.com/

控制台: https://platform.stepfun.com/

```json
{
  "provider": {
    "baseUrl": "https://api.stepfun.com/v1",
    "apiKey": "sk-...(env: STEPFUN_API_KEY)",
    "model": "step-2-16k"
  }
}
```

## Together AI  控制台: https://api.together.ai/

控制台: https://api.together.ai/

```json
{
  "provider": {
    "baseUrl": "https://api.together.xyz/v1",
    "apiKey": "sk-...(env: TOGETHER_API_KEY)",
    "model": "deepseek-ai/DeepSeek-V3"
  }
}
```
可选型号: deepseek-ai/DeepSeek-V3, Qwen/Qwen2.5-72B-Instruct-Turbo

## Venice AI(隐私优先)  控制台: https://venice.ai/

控制台: https://venice.ai/

```json
{
  "provider": {
    "baseUrl": "https://api.venice.ai/api/v1",
    "apiKey": "sk-...(env: VENICE_API_KEY)",
    "model": "qwen-2.5-coder-32b"
  }
}
```

## xAI Grok  控制台: https://console.x.ai/

控制台: https://console.x.ai/

```json
{
  "provider": {
    "baseUrl": "https://api.x.ai/v1",
    "apiKey": "sk-...(env: XAI_API_KEY)",
    "model": "grok-4"
  }
}
```
可选型号: grok-4, grok-3-mini

## 零一万物(01.AI)  控制台: https://platform.lingyiwanwu.com/

控制台: https://platform.lingyiwanwu.com/

```json
{
  "provider": {
    "baseUrl": "https://api.lingyiwanwu.com/v1",
    "apiKey": "sk-...(env: YI_API_KEY)",
    "model": "yi-large"
  }
}
```

## 多厂商按用途路由

```json
{
  "providers": {
    "strong": { "baseUrl": "https://api.example-a.com/v1", "apiKey": "sk-...", "model": "big-model" },
    "vision": { "baseUrl": "https://api.example-b.com/v1", "apiKey": "sk-...", "model": "vision-model" },
    "cheap":  { "baseUrl": "https://api.example-c.com/v1", "apiKey": "sk-...", "model": "small-model" }
  },
  "routing": { "chat": "strong", "vision": "vision", "evolve": "cheap", "bench": "cheap" }
}
```

- 未配置 `routing` 时所有用途共用 `provider`;
- `evolve` / `bench` 未配置时回退 `chat` 的路由;
- `vision` 未配置时回退 `vision` 字段(旧式)再回退 `provider`。

## 本地推理(可选,免 Key)

Ollama `http://127.0.0.1:11434/v1` · LM Studio `http://127.0.0.1:1234/v1` · vLLM `http://127.0.0.1:8000/v1` · llama.cpp server `http://127.0.0.1:8080/v1` —— 填入 provider.baseUrl 即可,模型名以本地服务实际加载为准。
