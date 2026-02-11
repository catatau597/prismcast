# Sumário Executivo - Implementação de Captura M3U8

## 📊 Visão Geral

| Item | Descrição |
|------|-----------|
| **Funcionalidade** | Capturar links M3U8 do tráfego de rede em vez de captura de tela |
| **Benefício Principal** | Melhor qualidade + menor uso de CPU |
| **Complexidade** | Média (requer integração com CDP e FFmpeg) |
| **Tempo Estimado** | 16-24 horas (desenvolvimento + testes) |
| **Impacto** | Baixo (feature opt-in, não afeta fluxo existente) |
| **Compatibilidade** | Sites que usam HLS/M3U8 (YouTube, ESPN+, etc.) |

---

## 📝 Resumo das Alterações

### Arquivos a Criar (1)

| Arquivo | Linhas | Descrição |
|---------|--------|-----------|
| **src/browser/m3u8Capture.ts** | ~150 | Módulo de captura M3U8 via CDP |

### Arquivos a Modificar (6)

| Arquivo | Alterações | Linhas Afetadas | Criticidade |
|---------|-----------|-----------------|-------------|
| **src/types/index.ts** | Adicionar 3 tipos/interfaces | ~30 | Alta |
| **src/streaming/setup.ts** | 2 funções + lógica branch | ~150 | Alta |
| **src/routes/config.ts** | UI toggle + handlers | ~80 | Média |
| **src/routes/ui.ts** | Estilos CSS toggle | ~40 | Baixa |
| **src/config/userChannels.ts** | Validação campo | ~10 | Baixa |
| **README.md** | Documentação | ~30 | Baixa |

**Total de linhas estimadas: ~490**

---

## 🔧 Mudanças Detalhadas por Arquivo

### 1. src/types/index.ts

```typescript
// ADICIONAR 3 novos tipos:

interface Channel {
  // ... campos existentes ...
  useM3u8Link?: boolean;  // ← NOVA flag
}

interface M3u8CaptureResult {
  success: boolean;
  m3u8Url?: string;
  reason?: string;
}

interface StreamSetupOptions {
  // ... campos existentes ...
  useM3u8Link?: boolean;  // ← NOVA opção
}
```

**Impacto**: Baixo - apenas adição de tipos opcionais

---

### 2. src/browser/m3u8Capture.ts (NOVO)

```typescript
// CRIAR arquivo completo com:

export async function captureM3u8FromNetwork(
  page: Page,
  url: string,
  profile: ResolvedSiteProfile
): Promise<M3u8CaptureResult>

export async function validateM3u8Url(m3u8Url: string): Promise<boolean>

function isM3u8Url(url: string): boolean
```

**Funcionalidades**:
- Monitoramento de rede via CDP
- Detecção de URLs M3U8
- Validação de URLs capturadas

---

### 3. src/streaming/setup.ts

#### Modificações em setupStream()

```typescript
// INSERIR após validações, antes de createPageWithCapture():

const shouldCaptureM3u8 = useM3u8Link ?? channel?.useM3u8Link ?? false;

if (shouldCaptureM3u8) {
  // Branch M3U8: criar página temporária, capturar, fechar
  const tempPage = await browser.newPage();
  try {
    const m3u8Result = await captureM3u8FromNetwork(tempPage, url, profile);
    if (!m3u8Result.success) throw StreamSetupError(503);
    return setupM3u8Stream({ ... });
  } finally {
    await tempPage.close();
  }
}

// Continua fluxo normal (screen capture)...
```

#### Nova função setupM3u8Stream()

```typescript
async function setupM3u8Stream(options: M3u8StreamSetupOptions): Promise<StreamSetupResult> {
  // Spawn FFmpeg -i m3u8_url
  // Retorna StreamSetupResult com captureStream = FFmpeg stdout
}
```

**Impacto**: Médio - adiciona branch condicional mas não modifica fluxo existente

---

### 4. src/routes/config.ts

#### Modificação em generateAdvancedFields()

```typescript
// ADICIONAR campo toggle dentro de advanced fields:

lines.push("<div class=\"form-row\">");
lines.push("<label>Use M3U8 Link</label>");
lines.push("<input type=\"checkbox\" id=\"useM3u8Link\" name=\"useM3u8Link\"" + 
  (useM3u8Link ? " checked" : "") + ">");
lines.push("</div>");
lines.push("<div class=\"hint\">When enabled, captures M3U8 link...</div>");
```

#### Modificação em POST/PUT handlers

```typescript
// ADICIONAR parsing do campo:

app.post("/api/channels", (req, res) => {
  const useM3u8Link = req.body.useM3u8Link === "on" || req.body.useM3u8Link === true;
  
  const newChannel: UserChannel = {
    // ... campos existentes ...
    useM3u8Link: useM3u8Link || undefined
  };
});
```

**Impacto**: Baixo - adiciona campo ao formulário, não afeta campos existentes

---

### 5. src/routes/ui.ts ou theme.ts

```css
/* ADICIONAR estilos para toggle */

.toggle-switch {
  appearance: none;
  width: 44px;
  height: 24px;
  background: var(--form-input-border);
  border-radius: 12px;
  /* ... */
}

.toggle-switch:checked {
  background: var(--interactive-primary);
}

.toggle-switch::before {
  content: "";
  /* círculo branco que desliza */
}
```

**Impacto**: Nulo - apenas CSS, não afeta funcionalidade existente

---

### 6. src/config/userChannels.ts

```typescript
// ATUALIZAR validateChannelData():

export function validateChannelData(channel: any): { valid: boolean; reason?: string } {
  // ... validações existentes ...
  
  if (channel.useM3u8Link !== undefined && typeof channel.useM3u8Link !== "boolean") {
    return { valid: false, reason: "useM3u8Link must be a boolean." };
  }
  
  return { valid: true };
}
```

**Impacto**: Nulo - adiciona validação para novo campo opcional

---

## 🎯 Matriz de Decisão

### Quando Usar M3U8 Capture?

| Site/Cenário | Usar M3U8? | Motivo |
|-------------|-----------|--------|
| YouTube Live | ✅ Sim | M3U8 aberto, sem DRM |
| Twitch | ✅ Sim | M3U8 acessível |
| ESPN+ (com login) | ✅ Sim | M3U8 após autenticação |
| Netflix | ❌ Não | DRM protegido |
| Site com player Flash | ❌ Não | Sem HLS |
| Pluto TV | ✅ Sim | M3U8 público |
| Hulu Live | ⚠️ Depende | Pode ter DRM |

---

## 🚦 Códigos de Status HTTP

| Situação | Código | Retry? | Mensagem |
|----------|--------|--------|----------|
| **M3U8 não detectado** | 503 | Sim (após 30s) | "No M3U8 link detected in network traffic" |
| **M3U8 inacessível** | 500 | Não | "Captured M3U8 URL is not accessible" |
| **Erro de navegação** | 503 | Sim | "Could not navigate to URL" |
| **FFmpeg falha** | 500 | Não | "Failed to process M3U8 stream" |
| **Sucesso** | 200 | N/A | Stream ativo |

---

## 📊 Comparação: Screen Capture vs M3U8

| Aspecto | Screen Capture (atual) | M3U8 Capture (novo) |
|---------|----------------------|---------------------|
| **CPU** | Alto (captura + encode) | Baixo (apenas remux) |
| **Qualidade** | Depende do viewport | Fonte original |
| **Latência** | ~5-10s | ~2-5s |
| **Compatibilidade** | Qualquer site com vídeo | Apenas HLS |
| **Requer login** | Sim | Sim (se site exigir) |
| **DRM** | Funciona (captura visual) | Não funciona |
| **Complexidade** | Média | Alta |
| **Estabilidade** | Alta | Depende do CDN |

---

## ⚠️ Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|-------|--------------|---------|-----------|
| M3U8 com DRM | Média | Alto | Retornar erro claro, usuário pode desabilitar flag |
| Site sem M3U8 | Baixa | Médio | Timeout + erro HTTP 503 |
| Token expira durante stream | Média | Alto | FFmpeg reconecta automaticamente |
| Múltiplos M3U8s detectados | Média | Baixo | Capturar primeiro (geralmente master playlist) |
| CDP session falha | Baixa | Alto | Try-catch + cleanup garantido |
| FFmpeg não instalado | Baixa | Alto | Já é dependência do projeto (WebM mode) |

---

## 🧪 Plano de Testes

### Testes Unitários

| Função | Teste | Entrada | Saída Esperada |
|--------|-------|---------|----------------|
| `isM3u8Url()` | Extensão .m3u8 | "video.m3u8" | true |
| `isM3u8Url()` | Query string | "live.m3u8?token=x" | true |
| `isM3u8Url()` | Não M3U8 | "video.mp4" | false |
| `validateM3u8Url()` | URL válida | HTTP 200 | true |
| `validateM3u8Url()` | URL quebrada | HTTP 404 | false |

### Testes de Integração

| Cenário | Setup | Resultado Esperado |
|---------|-------|-------------------|
| YouTube Live | useM3u8Link=true | Stream 200 OK |
| Site sem HLS | useM3u8Link=true | Erro 503 |
| Toggle UI | Adicionar canal, marcar checkbox | useM3u8Link salvo |
| Edit channel | Editar, desmarcar | useM3u8Link=false |
| Login flow | Site com auth + M3U8 | Stream após login |

### Testes Manuais

1. **Teste End-to-End Completo**:
   ```
   1. Adicionar canal YouTube Live
   2. Marcar "Use M3U8 Link"
   3. Salvar
   4. Iniciar stream via Channels DVR
   5. Verificar playback
   6. Checar logs: "M3U8 captured and validated"
   7. Verificar CPU < 20% (vs ~60% screen capture)
   ```

2. **Teste de Erro**:
   ```
   1. Criar canal com URL sem M3U8
   2. Marcar "Use M3U8 Link"
   3. Iniciar stream
   4. Verificar erro HTTP 503
   5. Mensagem clara no Channels DVR
   ```

---

## 📈 Métricas de Sucesso

| Métrica | Baseline (Screen) | Target (M3U8) |
|---------|------------------|---------------|
| CPU por stream | 60% | < 20% |
| Latência inicial | 8-12s | 3-5s |
| Qualidade (bitrate) | ~8 Mbps | Fonte original (15-20 Mbps) |
| Taxa de erro | < 5% | < 10% (sites sem M3U8) |
| Tempo de setup | ~15s | ~8s |

---

## 🗓️ Cronograma de Desenvolvimento

### Fase 1: Estrutura (4h)
- [x] Definir tipos (1h)
- [x] Criar esqueleto m3u8Capture.ts (1h)
- [x] Adicionar estilos CSS (1h)
- [x] Setup inicial testes (1h)

### Fase 2: Core M3U8 Capture (6h)
- [ ] Implementar captureM3u8FromNetwork() (3h)
- [ ] Implementar validateM3u8Url() (1h)
- [ ] Testes captura isolada (2h)

### Fase 3: Integração Setup (4h)
- [ ] Modificar setupStream() (2h)
- [ ] Implementar setupM3u8Stream() (2h)

### Fase 4: UI (3h)
- [ ] Adicionar toggle em formulário (1h)
- [ ] Atualizar handlers POST/PUT (1h)
- [ ] Testes UI (1h)

### Fase 5: Testes e Documentação (3h)
- [ ] Testes integração (2h)
- [ ] Atualizar README (1h)

**Total: 20 horas**

---

## ✅ Checklist de Implementação

### Código

- [ ] Tipos definidos em `src/types/index.ts`
- [ ] Arquivo `src/browser/m3u8Capture.ts` criado
- [ ] Função `captureM3u8FromNetwork()` implementada
- [ ] Função `setupM3u8Stream()` implementada
- [ ] Branch M3U8 em `setupStream()` adicionado
- [ ] Toggle UI em `generateAdvancedFields()`
- [ ] Handlers POST/PUT atualizados
- [ ] Estilos CSS adicionados
- [ ] Validação em `userChannels.ts`

### Testes

- [ ] Teste: YouTube Live funciona
- [ ] Teste: Site sem M3U8 retorna 503
- [ ] Teste: Toggle persiste ao salvar
- [ ] Teste: Edição mantém estado
- [ ] Teste: Login + M3U8 funciona
- [ ] Teste: Validação de URL

### Documentação

- [ ] README.md atualizado
- [ ] Comentários inline adicionados
- [ ] Exemplos de uso documentados
- [ ] Guia de troubleshooting

### Review

- [ ] Código sem erros TypeScript
- [ ] Logs informativos em cada etapa
- [ ] Tratamento de erros completo
- [ ] Cleanup garantido (finally blocks)
- [ ] Performance aceitável (< 20% CPU)

---

## 📚 Documentação Adicional

Este sumário faz parte de um conjunto de documentos:

1. **PLANO_IMPLEMENTACAO_M3U8.md** - Plano completo e detalhado
2. **FLUXO_DETALHADO_M3U8.md** - Pseudocódigo e diagramas
3. **SUMARIO_EXECUTIVO_M3U8.md** - Este documento (overview rápido)

---

## 🎓 Próximos Passos

### Imediatos (Semana 1)
1. Revisar aprovação do plano
2. Criar branch feature/m3u8-capture
3. Implementar Fase 1 (estrutura)
4. Code review inicial

### Curto Prazo (Semana 2-3)
1. Implementar Fases 2-4 (core + UI)
2. Testes integração
3. Beta testing com usuários

### Longo Prazo (Futuro)
1. Suporte DASH (.mpd) além de HLS
2. Auto-detecção (tentar M3U8, fallback automático)
3. Cache de M3U8 URLs (evitar recaptura)
4. Métricas de uso (quantos canais usam M3U8)

---

**Versão**: 1.0  
**Data**: Fevereiro 2026  
**Status**: Pronto para implementação  
**Aprovação**: Pendente
