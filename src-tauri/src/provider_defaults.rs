use crate::{
    ProviderAppBinding, ProviderConfig, ProviderDetails, ProviderEndpoint, ProviderEnvVar,
    ProviderModel,
};
use chrono::Local;
use uuid::Uuid;

pub struct ProviderTemplate {
    pub provider: &'static str,
    pub label: &'static str,
    pub base_url: &'static str,
    pub models: Vec<&'static str>,
    pub env_vars: Vec<&'static str>,
    pub endpoints: Vec<EndpointTemplate>,
    pub app_bindings: Vec<AppBindingTemplate>,
}

pub struct EndpointTemplate {
    pub base_url: &'static str,
    pub headers: Option<&'static str>,
    pub timeout_ms: Option<i64>,
    pub proxy_url: Option<&'static str>,
    pub is_primary: bool,
}

pub struct AppBindingTemplate {
    pub app_type: &'static str,
    pub config_path: &'static str,
    pub enabled: bool,
}

pub fn default_templates() -> Vec<ProviderTemplate> {
    vec![
        ProviderTemplate {
            provider: "openai",
            label: "OpenAI",
            base_url: "https://api.openai.com/v1",
            models: vec!["gpt-4o-mini", "gpt-4.1", "gpt-4o"],
            env_vars: vec!["OPENAI_API_KEY", "OPENAI_BASE_URL"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://api.openai.com/v1",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![
                AppBindingTemplate {
                    app_type: "openai-compatible",
                    config_path: "",
                    enabled: true,
                },
                AppBindingTemplate {
                    app_type: "codex",
                    config_path: "",
                    enabled: false,
                },
                AppBindingTemplate {
                    app_type: "opencode",
                    config_path: "",
                    enabled: false,
                },
                AppBindingTemplate {
                    app_type: "openclaw",
                    config_path: "",
                    enabled: false,
                },
            ],
        },
        ProviderTemplate {
            provider: "anthropic",
            label: "Anthropic",
            base_url: "https://api.anthropic.com/v1",
            models: vec!["claude-3.5-sonnet", "claude-3.5-haiku"],
            env_vars: vec!["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://api.anthropic.com/v1",
                headers: Some("anthropic-version: 2023-06-01"),
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "claude-code",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "google-ai",
            label: "Google AI",
            base_url: "https://generativelanguage.googleapis.com",
            models: vec!["gemini-1.5-pro", "gemini-1.5-flash"],
            env_vars: vec!["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://generativelanguage.googleapis.com",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "gemini",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "gemini",
            label: "Gemini",
            base_url: "https://generativelanguage.googleapis.com",
            models: vec!["gemini-1.5-pro", "gemini-1.5-flash"],
            env_vars: vec!["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://generativelanguage.googleapis.com",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "gemini",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "azure-openai",
            label: "Azure OpenAI",
            base_url: "https://{resource}.openai.azure.com",
            models: vec!["gpt-4o", "gpt-4o-mini"],
            env_vars: vec!["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://{resource}.openai.azure.com",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "openrouter",
            label: "OpenRouter",
            base_url: "https://openrouter.ai/api/v1",
            models: vec!["openrouter/auto"],
            env_vars: vec!["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://openrouter.ai/api/v1",
                headers: Some("HTTP-Referer: https://your.app"),
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "deepseek",
            label: "DeepSeek",
            base_url: "https://api.deepseek.com",
            models: vec!["deepseek-chat", "deepseek-reasoner"],
            env_vars: vec!["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://api.deepseek.com",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "groq",
            label: "Groq",
            base_url: "https://api.groq.com/openai/v1",
            models: vec![],
            env_vars: vec!["GROQ_API_KEY"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://api.groq.com/openai/v1",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "mistral",
            label: "Mistral",
            base_url: "https://api.mistral.ai/v1",
            models: vec![],
            env_vars: vec!["MISTRAL_API_KEY"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://api.mistral.ai/v1",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "ollama",
            label: "Ollama",
            base_url: "http://localhost:11434/v1",
            models: vec![],
            env_vars: vec!["OLLAMA_BASE_URL"],
            endpoints: vec![EndpointTemplate {
                base_url: "http://localhost:11434/v1",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "perplexity",
            label: "Perplexity",
            base_url: "https://api.perplexity.ai",
            models: vec![],
            env_vars: vec!["PERPLEXITY_API_KEY"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://api.perplexity.ai",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "together",
            label: "Together",
            base_url: "https://api.together.xyz/v1",
            models: vec![],
            env_vars: vec!["TOGETHER_API_KEY"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://api.together.xyz/v1",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "xai",
            label: "xAI",
            base_url: "https://api.x.ai/v1",
            models: vec![],
            env_vars: vec!["XAI_API_KEY"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://api.x.ai/v1",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "volcengine",
            label: "Volcengine",
            base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
            models: vec!["ark-code-latest"],
            env_vars: vec!["ARK_API_KEY", "VOLCENGINE_API_KEY"],
            endpoints: vec![
                EndpointTemplate {
                    base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: true,
                },
                EndpointTemplate {
                    base_url: "https://ark.cn-beijing.volces.com/api/v3",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: false,
                },
            ],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "glm",
            label: "GLM",
            base_url: "https://open.bigmodel.cn/api/paas/v4",
            models: vec![
                "glm-4.7",
                "glm-4.6",
                "glm-4.6v",
                "glm-4.6v-flash",
                "glm-4.5",
                "glm-4.5-air",
                "glm-4.5-flash",
                "glm-4.5v",
            ],
            env_vars: vec!["ZHIPU_API_KEY", "ZHIPU_BASE_URL"],
            endpoints: vec![
                EndpointTemplate {
                    base_url: "https://open.bigmodel.cn/api/paas/v4",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: true,
                },
                EndpointTemplate {
                    base_url: "https://api.z.ai/api/paas/v4",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: false,
                },
            ],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "qwen",
            label: "Qwen",
            base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            models: vec![
                "qwen3-max",
                "qwen3-max-preview",
                "qwen-plus",
                "qwen-plus-latest",
                "qwen-flash",
                "qwen3-32b",
                "qwen3-14b",
            ],
            env_vars: vec!["DASHSCOPE_API_KEY"],
            endpoints: vec![
                EndpointTemplate {
                    base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: true,
                },
                EndpointTemplate {
                    base_url: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: false,
                },
                EndpointTemplate {
                    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: false,
                },
            ],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "minimax",
            label: "MiniMax",
            base_url: "https://api.minimax.io/v1",
            models: vec!["MiniMax-M2.1", "codex-MiniMax-M2.1"],
            env_vars: vec!["MINIMAX_API_KEY", "MINIMAX_BASE_URL"],
            endpoints: vec![
                EndpointTemplate {
                    base_url: "https://api.minimax.io/v1",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: true,
                },
                EndpointTemplate {
                    base_url: "https://api.minimaxi.com/v1",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: false,
                },
            ],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "kimi",
            label: "Kimi",
            base_url: "https://api.moonshot.ai/v1",
            models: vec![
                "kimi-for-coding",
                "kimi-k2-0711-preview",
                "kimi-k2-0905-preview",
                "kimi-k2-thinking",
                "kimi-k2-thinking-turbo",
                "kimi-k2-turbo-preview",
            ],
            env_vars: vec!["MOONSHOT_API_KEY", "KIMI_API_KEY"],
            endpoints: vec![
                EndpointTemplate {
                    base_url: "https://api.moonshot.ai/v1",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: true,
                },
                EndpointTemplate {
                    base_url: "https://api.moonshot.cn/v1",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: false,
                },
            ],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "kimi-for-coding",
            label: "Kimi for Coding",
            base_url: "https://api.kimi.com/coding",
            models: vec!["kimi-for-coding"],
            env_vars: vec!["KIMI_API_KEY"],
            endpoints: vec![
                EndpointTemplate {
                    base_url: "https://api.kimi.com/coding",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: true,
                },
                EndpointTemplate {
                    base_url: "https://api.moonshot.ai/v1",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: false,
                },
            ],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "deepl",
            label: "DeepL",
            base_url: "https://api-free.deepl.com/v2",
            models: vec![],
            env_vars: vec!["DEEPL_API_KEY"],
            endpoints: vec![
                EndpointTemplate {
                    base_url: "https://api-free.deepl.com/v2",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: true,
                },
                EndpointTemplate {
                    base_url: "https://api.deepl.com/v2",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: false,
                },
            ],
            app_bindings: vec![],
        },
        ProviderTemplate {
            provider: "google-translate",
            label: "Google Translate",
            base_url: "https://translation.googleapis.com/language/translate/v2",
            models: vec![],
            env_vars: vec!["GOOGLE_TRANSLATE_API_KEY"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://translation.googleapis.com/language/translate/v2",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![],
        },
        ProviderTemplate {
            provider: "tavily",
            label: "Tavily",
            base_url: "https://api.tavily.com",
            models: vec![],
            env_vars: vec!["TAVILY_API_KEY"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://api.tavily.com",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![],
        },
        ProviderTemplate {
            provider: "serpapi",
            label: "SerpAPI",
            base_url: "https://serpapi.com",
            models: vec![],
            env_vars: vec!["SERPAPI_API_KEY"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://serpapi.com",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![],
        },
        ProviderTemplate {
            provider: "ocr-space",
            label: "OCR.Space",
            base_url: "https://api.ocr.space",
            models: vec![],
            env_vars: vec!["OCR_SPACE_API_KEY"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://api.ocr.space",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![],
        },
        ProviderTemplate {
            provider: "coingecko",
            label: "CoinGecko",
            base_url: "https://api.coingecko.com/api/v3",
            models: vec![],
            env_vars: vec!["COINGECKO_API_KEY"],
            endpoints: vec![
                EndpointTemplate {
                    base_url: "https://api.coingecko.com/api/v3",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: true,
                },
                EndpointTemplate {
                    base_url: "https://pro-api.coingecko.com/api/v3",
                    headers: None,
                    timeout_ms: Some(60000),
                    proxy_url: None,
                    is_primary: false,
                },
            ],
            app_bindings: vec![],
        },
        ProviderTemplate {
            provider: "opencode",
            label: "OpenCode",
            base_url: "",
            models: vec![],
            env_vars: vec!["OPENCODE_API_KEY"],
            endpoints: vec![],
            app_bindings: vec![AppBindingTemplate {
                app_type: "opencode",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "openclaw",
            label: "OpenClaw",
            base_url: "",
            models: vec![],
            env_vars: vec!["OPENCLAW_API_KEY"],
            endpoints: vec![],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openclaw",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "amp",
            label: "Amp",
            base_url: "",
            models: vec![],
            env_vars: vec!["AMP_API_KEY", "AMP_CLI_PATH"],
            endpoints: vec![],
            app_bindings: vec![AppBindingTemplate {
                app_type: "amp",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "github-copilot",
            label: "GitHub Copilot",
            base_url: "https://models.inference.ai.azure.com",
            models: vec!["gpt-4o", "gpt-4.1"],
            env_vars: vec!["GITHUB_TOKEN", "GITHUB_COPILOT_TOKEN"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://models.inference.ai.azure.com",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "github",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "antigravity",
            label: "Antigravity",
            base_url: "http://127.0.0.1:8765/v1",
            models: vec!["antigravity"],
            env_vars: vec!["ANTIGRAVITY_API_KEY", "ANTIGRAVITY_BASE_URL"],
            endpoints: vec![EndpointTemplate {
                base_url: "http://127.0.0.1:8765/v1",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "antigravity",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "zai",
            label: "Z.ai",
            base_url: "https://api.z.ai/api/paas/v4",
            models: vec!["glm-4.7"],
            env_vars: vec!["ZAI_API_KEY", "GLM_API_KEY"],
            endpoints: vec![EndpointTemplate {
                base_url: "https://api.z.ai/api/paas/v4",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "z.ai",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "bedrock",
            label: "AWS Bedrock",
            base_url: "https://bedrock-runtime.us-east-1.amazonaws.com",
            models: vec!["anthropic.claude-sonnet-4-5"],
            env_vars: vec![
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_SESSION_TOKEN",
                "AWS_REGION",
            ],
            endpoints: vec![EndpointTemplate {
                base_url: "https://bedrock-runtime.us-east-1.amazonaws.com",
                headers: None,
                timeout_ms: Some(60000),
                proxy_url: None,
                is_primary: true,
            }],
            app_bindings: vec![AppBindingTemplate {
                app_type: "aws",
                config_path: "",
                enabled: true,
            }],
        },
        ProviderTemplate {
            provider: "cursor",
            label: "Cursor",
            base_url: "",
            models: vec![],
            env_vars: vec!["CURSOR_API_KEY"],
            endpoints: vec![],
            app_bindings: vec![AppBindingTemplate {
                app_type: "openai-compatible",
                config_path: "",
                enabled: false,
            }],
        },
        ProviderTemplate {
            provider: "other",
            label: "Other",
            base_url: "",
            models: vec![],
            env_vars: vec![],
            endpoints: vec![],
            app_bindings: vec![],
        },
    ]
}

pub fn template_to_provider_config(template: &ProviderTemplate) -> ProviderConfig {
    let now = Local::now().to_rfc3339();
    ProviderConfig {
        provider: template.provider.to_string(),
        label: template.label.to_string(),
        api_key: String::new(),
        base_url: template.base_url.to_string(),
        updated_at: now,
        is_active: false,
        models: template
            .models
            .iter()
            .map(|model| (*model).to_string())
            .collect(),
        details: ProviderDetails::default(),
        endpoints: Vec::new(),
        env_vars: Vec::new(),
        app_bindings: Vec::new(),
    }
}

pub fn template_to_endpoints(template: &ProviderTemplate) -> Vec<ProviderEndpoint> {
    let now = Local::now().to_rfc3339();
    template
        .endpoints
        .iter()
        .map(|endpoint| ProviderEndpoint {
            id: Uuid::new_v4().to_string(),
            provider: template.provider.to_string(),
            base_url: endpoint.base_url.to_string(),
            headers: endpoint.headers.map(|value| value.to_string()),
            timeout_ms: endpoint.timeout_ms,
            proxy_url: endpoint.proxy_url.map(|value| value.to_string()),
            is_primary: endpoint.is_primary,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .collect()
}

pub fn template_to_models(template: &ProviderTemplate) -> Vec<ProviderModel> {
    let now = Local::now().to_rfc3339();
    template
        .models
        .iter()
        .map(|name| ProviderModel {
            id: Uuid::new_v4().to_string(),
            provider: template.provider.to_string(),
            name: name.to_string(),
            alias: None,
            context_window: None,
            input_price: None,
            output_price: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .collect()
}

pub fn template_to_env_vars(template: &ProviderTemplate) -> Vec<ProviderEnvVar> {
    let now = Local::now().to_rfc3339();
    template
        .env_vars
        .iter()
        .map(|key| ProviderEnvVar {
            id: Uuid::new_v4().to_string(),
            provider: template.provider.to_string(),
            key: key.to_string(),
            value: String::new(),
            is_secret: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .collect()
}

pub fn template_to_app_bindings(template: &ProviderTemplate) -> Vec<ProviderAppBinding> {
    let now = Local::now().to_rfc3339();
    template
        .app_bindings
        .iter()
        .map(|binding| ProviderAppBinding {
            id: Uuid::new_v4().to_string(),
            provider: template.provider.to_string(),
            app_type: binding.app_type.to_string(),
            config_path: binding.config_path.to_string(),
            enabled: binding.enabled,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .collect()
}
