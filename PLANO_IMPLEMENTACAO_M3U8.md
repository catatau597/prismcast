# Plano de Implementação - Captura de Links M3U8

## 📋 Visão Geral

**Objetivo**: Adicionar funcionalidade ao PrismCast para capturar links M3U8 diretamente de sites de streaming e usá-los como fonte, em vez de realizar captura de tela.

**Benefícios**:
- Melhor qualidade de vídeo (fonte direta)
- Menor uso de CPU (sem captura de tela)
- Menor latência
- Maior estabilidade

---

## 🏗️ Arquitetura Atual do PrismCast

### Fluxo de Streaming Existente

```
1. Cliente solicita stream → /hls/:channel/stream.m3u8
2. setupStream() valida e configura
3. createPageWithCapture():
   - Cria página Chrome via Puppeteer
   - Inicia captura via puppeteer-stream (tabCapture API)
   - Navega para URL
   - Encontra elemento <video>
   - Aplica fullscreen
4. Captura vídeo/áudio:
   - WebM (H264+Opus) → FFmpeg → fMP4 (H264+AAC)
   - OU fMP4 nativo (H264+AAC)
5. fMP4Segmenter:
   - Parse MP4 boxes
   - Gera init.mp4 + segment0.m4s, segment1.m4s...
6. Cliente baixa segments via /hls/:channel/segmentN.m4s
```

### Componentes Chave

- **src/streaming/setup.ts**: Configuração de streams
- **src/browser/video.ts**: Manipulação do elemento `<video>`
- **src/streaming/hls.ts**: Handlers HLS
- **src/types/index.ts**: Definições de tipos
- **src/config/sites.ts**: Perfis de comportamento por site
- **src/routes/config.ts**: UI de gerenciamento de canais

---

## 🎯 Objetivo da Implementação

### Novo Fluxo com M3U8

```
1. Cliente solicita stream → /hls/:channel/stream.m3u8
2. setupStream() verifica channel.useM3u8Link
3. SE useM3u8Link = true:
   a. Cria página Chrome (sem captura de tela)
   b. Navega para URL
   c. Aguarda login se necessário
   d. Captura link M3U8 do Network tab via CDP
   e. Fecha a página do browser
   f. Usa FFmpeg para:
      - Baixar M3U8
      - Re-empacotar para HLS segments
   g. fMP4Segmenter processa saída do FFmpeg
4. SE falhar captura M3U8:
   - Retorna erro HTTP 503 ou 500
   - NÃO faz fallback para captura de tela
```

---

## 📝 Alterações Necessárias

### 1. Tipos (src/types/index.ts)

#### 1.1 Adicionar flag no Channel

```typescript
export interface Channel {
  // ... campos existentes ...
  
  /**
   * When true, attempts to capture the M3U8 link from network traffic instead of screen capture.
   * If M3U8 link cannot be captured, the stream will fail with an error instead of falling back to screen capture.
   * The site may require login before the M3U8 link becomes available in network traffic.
   */
  useM3u8Link?: boolean;
}
```

#### 1.2 Adicionar tipo para resultado de captura M3U8

```typescript
/**
 * Result of attempting to capture an M3U8 link from network traffic.
 */
export interface M3u8CaptureResult {
  /**
   * Whether the M3U8 link was successfully captured.
   */
  success: boolean;

  /**
   * The captured M3U8 URL, present only when success is true.
   */
  m3u8Url?: string;

  /**
   * Human-readable reason why capture failed, present only when success is false.
   */
  reason?: string;
}
```

#### 1.3 Atualizar StreamSetupOptions

```typescript
export interface StreamSetupOptions {
  // ... campos existentes ...
  
  /**
   * Whether to capture M3U8 link instead of screen capture.
   */
  useM3u8Link?: boolean;
}
```

---

### 2. Novo Módulo: Captura de M3U8 (src/browser/m3u8Capture.ts)

**Criar novo arquivo** com funções para capturar links M3U8 via Chrome DevTools Protocol (CDP).

```typescript
/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * m3u8Capture.ts: M3U8 link capture from network traffic for PrismCast.
 */
import type { CDPSession, Page } from "puppeteer-core";
import type { M3u8CaptureResult, ResolvedSiteProfile } from "../types/index.js";
import { LOG, delay, formatError } from "../utils/index.js";
import { CONFIG } from "../config/index.js";
import { navigateToPage } from "./video.js";

/**
 * Timeout for waiting for M3U8 link to appear in network traffic (ms).
 * Sites may take time to load player and request the M3U8 manifest.
 */
const M3U8_CAPTURE_TIMEOUT = 15000;

/**
 * Patterns to identify M3U8/HLS manifest URLs in network traffic.
 * Matches both .m3u8 file extensions and common HLS manifest patterns.
 */
const M3U8_URL_PATTERNS = [
  /\.m3u8(\?.*)?$/i,
  /\/manifest\.m3u8/i,
  /\/playlist\.m3u8/i,
  /\/master\.m3u8/i,
  /hls.*\.m3u8/i
];

/**
 * Checks if a URL matches M3U8/HLS manifest patterns.
 * @param url - The URL to check.
 * @returns True if the URL appears to be an M3U8 manifest.
 */
function isM3u8Url(url: string): boolean {
  return M3U8_URL_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * Captures an M3U8 link from network traffic by monitoring Chrome's network requests.
 * 
 * The process:
 * 1. Creates a CDP session to access Network domain
 * 2. Enables network request tracking
 * 3. Navigates to the streaming page
 * 4. Waits for login if needed (based on profile.waitForNetworkIdle)
 * 5. Monitors network traffic for M3U8 URLs
 * 6. Returns the first valid M3U8 link found
 * 
 * @param page - The Puppeteer page object.
 * @param url - The URL to navigate to.
 * @param profile - The site profile for navigation behavior.
 * @returns Result containing the captured M3U8 URL or failure reason.
 */
export async function captureM3u8FromNetwork(
  page: Page,
  url: string,
  profile: ResolvedSiteProfile
): Promise<M3u8CaptureResult> {
  
  let cdpSession: CDPSession | null = null;
  let capturedM3u8: string | null = null;

  try {
    // Create CDP session for network monitoring
    cdpSession = await page.createCDPSession();
    await cdpSession.send("Network.enable");

    LOG.info("Network monitoring enabled, waiting for M3U8 link...");

    // Listen for network responses
    cdpSession.on("Network.responseReceived", (params: any) => {
      const responseUrl = params.response?.url;
      
      if (responseUrl && isM3u8Url(responseUrl) && !capturedM3u8) {
        LOG.info("M3U8 link captured: %s", responseUrl);
        capturedM3u8 = responseUrl;
      }
    });

    // Navigate to the page (respects profile.waitForNetworkIdle for login)
    await navigateToPage(page, url, profile);

    LOG.info("Page loaded, monitoring network traffic for M3U8...");

    // Wait for M3U8 link to appear, with timeout
    const startTime = Date.now();
    while (!capturedM3u8 && (Date.now() - startTime) < M3U8_CAPTURE_TIMEOUT) {
      await delay(500);
    }

    if (!capturedM3u8) {
      return {
        success: false,
        reason: "No M3U8 link detected in network traffic within timeout period."
      };
    }

    return {
      success: true,
      m3u8Url: capturedM3u8
    };

  } catch (error) {
    LOG.error("M3U8 capture failed: %s", formatError(error));
    
    return {
      success: false,
      reason: `M3U8 capture error: ${formatError(error)}`
    };
  } finally {
    // Clean up CDP session
    if (cdpSession) {
      try {
        await cdpSession.detach();
      } catch {
        // Ignore detach errors
      }
    }
  }
}

/**
 * Validates that a captured M3U8 URL is accessible.
 * @param m3u8Url - The M3U8 URL to validate.
 * @returns True if the URL responds successfully.
 */
export async function validateM3u8Url(m3u8Url: string): Promise<boolean> {
  try {
    const response = await fetch(m3u8Url, { 
      method: "HEAD",
      signal: AbortSignal.timeout(5000)
    });
    
    return response.ok;
  } catch (error) {
    LOG.warn("M3U8 validation failed for %s: %s", m3u8Url, formatError(error));
    return false;
  }
}
```

---

### 3. Atualizar Setup de Stream (src/streaming/setup.ts)

#### 3.1 Adicionar imports

```typescript
import { captureM3u8FromNetwork } from "../browser/m3u8Capture.js";
import type { M3u8CaptureResult } from "../types/index.js";
```

#### 3.2 Modificar setupStream()

Adicionar lógica antes de `createPageWithCapture()`:

```typescript
export async function setupStream(options: StreamSetupOptions, onCircuitBreak: () => void): Promise<StreamSetupResult> {
  const { channel, channelName, useM3u8Link, /* ... outros campos ... */ } = options;

  // ... código existente de validação ...

  // ==================== NOVA LÓGICA M3U8 ====================
  
  // Check if M3U8 capture mode is enabled
  const shouldCaptureM3u8 = useM3u8Link ?? channel?.useM3u8Link ?? false;

  if (shouldCaptureM3u8) {
    LOG.info("M3U8 capture mode enabled for %s", url);
    
    // Create temporary page for M3U8 capture (no screen capture)
    const browser = await getCurrentBrowser();
    const tempPage = await browser.newPage();
    registerManagedPage(tempPage);

    let m3u8Result: M3u8CaptureResult;
    
    try {
      // Capture M3U8 link from network traffic
      m3u8Result = await captureM3u8FromNetwork(tempPage, url, profile);
      
      if (!m3u8Result.success) {
        throw new StreamSetupError(
          `M3U8 capture failed: ${m3u8Result.reason}`,
          503,
          `Could not capture M3U8 link from ${extractDomain(url)}. ${m3u8Result.reason ?? ''}`
        );
      }

      LOG.info("M3U8 link captured successfully: %s", m3u8Result.m3u8Url);

    } finally {
      // Clean up temporary page
      unregisterManagedPage(tempPage);
      if (!tempPage.isClosed()) {
        await tempPage.close().catch(() => {});
      }
    }

    // Use M3U8 URL for streaming via FFmpeg
    return setupM3u8Stream({
      m3u8Url: m3u8Result.m3u8Url!,
      channelName: channel?.name ?? null,
      metadataComment,
      numericStreamId,
      onCircuitBreak,
      profile,
      profileName,
      providerName,
      startTime,
      streamId,
      url
    });
  }

  // ==================== FIM NOVA LÓGICA M3U8 ====================

  // Continua com fluxo normal de captura de tela...
  const captureResult = await createPageWithCapture({ /* ... */ });
  // ... resto do código existente ...
}
```

#### 3.3 Criar função setupM3u8Stream()

Nova função no mesmo arquivo (setup.ts):

```typescript
/**
 * Options for setting up an M3U8-based stream (no screen capture).
 */
interface M3u8StreamSetupOptions {
  m3u8Url: string;
  channelName: Nullable<string>;
  metadataComment: string | undefined;
  numericStreamId: number;
  onCircuitBreak: () => void;
  profile: ResolvedSiteProfile;
  profileName: string;
  providerName: string;
  startTime: Date;
  streamId: string;
  url: string;
}

/**
 * Sets up a stream using a captured M3U8 URL instead of screen capture.
 * Uses FFmpeg to download and re-segment the M3U8 stream.
 * 
 * @param options - M3U8 stream setup options.
 * @returns Stream setup result with FFmpeg process and cleanup.
 */
async function setupM3u8Stream(options: M3u8StreamSetupOptions): Promise<StreamSetupResult> {
  const { 
    m3u8Url, 
    channelName, 
    metadataComment, 
    numericStreamId,
    onCircuitBreak,
    profile,
    profileName,
    providerName,
    startTime,
    streamId,
    url
  } = options;

  // Spawn FFmpeg to process M3U8 → fMP4
  const ffmpegArgs = [
    "-i", m3u8Url,                    // Input M3U8 URL
    "-c:v", "copy",                   // Copy video stream (no transcode)
    "-c:a", "aac",                    // Transcode audio to AAC if needed
    "-b:a", String(CONFIG.streaming.audioBitsPerSecond),
    "-f", "mp4",                      // Output as MP4
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-"                               // Output to stdout
  ];

  if (metadataComment) {
    ffmpegArgs.unshift("-metadata", `comment=${metadataComment}`);
  }

  const ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  ffmpegProcess.on("error", (error) => {
    LOG.error("FFmpeg M3U8 process error: %s", formatError(error));
    onCircuitBreak();
  });

  // Log FFmpeg stderr
  ffmpegProcess.stderr.on("data", (data) => {
    LOG.debug("FFmpeg M3U8: %s", data.toString().trim());
  });

  const captureStream = ffmpegProcess.stdout;

  // Monitor stream info (no health monitoring for M3U8 - FFmpeg handles it)
  const monitorStreamInfo: MonitorStreamInfo = {
    channelName,
    numericStreamId,
    providerName,
    startTime
  };

  // For M3U8 streams, we don't do playback health monitoring
  // FFmpeg will handle reconnection and errors
  const stopMonitor = () => ({ 
    attemptCount: 0,
    circuitBreakerTripped: false,
    lastIssueTime: null,
    lastIssueType: null,
    pageReloadsInWindow: 0
  });

  // Cleanup function
  let cleanupCompleted = false;
  const cleanup = async (): Promise<void> => {
    if (cleanupCompleted) return;
    cleanupCompleted = true;

    stopMonitor();
    
    if (!captureStream.destroyed) {
      captureStream.destroy();
    }

    ffmpegProcess.kill("SIGTERM");
  };

  return {
    captureStream,
    channelName,
    cleanup,
    ffmpegProcess,
    numericStreamId,
    page: null as any, // M3U8 streams don't have a browser page
    profile,
    profileName,
    providerName,
    rawCaptureStream: captureStream, // Same as captureStream for M3U8
    startTime,
    stopMonitor,
    streamId,
    url
  };
}
```

---

### 4. UI - Formulários de Canal (src/routes/config.ts)

#### 4.1 Atualizar generateAdvancedFields()

Adicionar toggle para "Use M3U8 Link" nos campos avançados:

```typescript
function generateAdvancedFields(
  idPrefix: string, 
  stationIdValue: string, 
  channelSelectorValue: string, 
  channelNumberValue: string,
  useM3u8LinkValue: boolean = false, // NOVO parâmetro
  showHints = true
): string[] {
  
  const lines: string[] = [];

  // ... toggle existente ...

  lines.push("<div id=\"" + idPrefix + "-advanced\" class=\"advanced-fields\">");

  // ==================== NOVO CAMPO: Use M3U8 Link ====================
  
  lines.push("<div class=\"form-row\">");
  lines.push("<label for=\"" + idPrefix + "-useM3u8Link\" class=\"form-label-toggle\">");
  lines.push("<span class=\"toggle-label-text\">Use M3U8 Link</span>");
  lines.push("</label>");
  
  const checkedAttr = useM3u8LinkValue ? " checked" : "";
  lines.push("<input type=\"checkbox\" class=\"form-checkbox toggle-switch\" id=\"" + 
    idPrefix + "-useM3u8Link\" name=\"useM3u8Link\"" + checkedAttr + ">");
  
  lines.push("</div>");

  if (showHints) {
    lines.push("<div class=\"hint\">");
    lines.push("When enabled, PrismCast will capture the M3U8 link from network traffic instead of screen capture. ");
    lines.push("This provides better quality and lower CPU usage. The site may require login before the M3U8 becomes available. ");
    lines.push("If M3U8 capture fails, the stream will not fall back to screen capture.");
    lines.push("</div>");
  }

  // ==================== FIM NOVO CAMPO ====================

  // ... campos existentes (stationId, channelSelector, channelNumber) ...

  lines.push("</div>"); // End advanced fields

  return lines;
}
```

#### 4.2 Atualizar generateChannelRowHtml()

Incluir valor de `useM3u8Link` ao chamar `generateAdvancedFields()`:

```typescript
export function generateChannelRowHtml(key: string, profiles: ProfileInfo[]): ChannelRowHtml {
  // ... código existente ...

  // Na parte do edit form:
  const useM3u8Link = channel.useM3u8Link ?? false;

  editLines.push(...generateAdvancedFields(
    "edit",
    channel.stationId ?? "",
    channel.channelSelector ?? "",
    String(channel.channelNumber ?? ""),
    useM3u8Link, // NOVO
    false
  ));

  // ... resto do código ...
}
```

#### 4.3 Atualizar handlers de POST/PUT

No handler de adicionar canal (POST /api/channels):

```typescript
app.post("/api/channels", async (req: Request, res: Response) => {
  // ... código existente ...

  const useM3u8Link = req.body.useM3u8Link === "on" || req.body.useM3u8Link === true;

  const newChannel: UserChannel = {
    url: validatedUrl,
    name: channelName || undefined,
    profile: profile || undefined,
    stationId: stationId || undefined,
    channelSelector: channelSelector || undefined,
    channelNumber: channelNumberInt,
    useM3u8Link: useM3u8Link || undefined  // NOVO
  };

  // ... resto do código ...
});
```

No handler de editar canal (PUT /api/channels/:key):

```typescript
app.put("/api/channels/:key", async (req: Request, res: Response) => {
  // ... código existente ...

  const useM3u8Link = req.body.useM3u8Link === "on" || req.body.useM3u8Link === true;

  const updatedChannel: UserChannel = {
    url: validatedUrl,
    name: channelName || undefined,
    profile: profile || undefined,
    stationId: stationId || undefined,
    channelSelector: channelSelector || undefined,
    channelNumber: channelNumberInt,
    useM3u8Link: useM3u8Link || undefined  // NOVO
  };

  // ... resto do código ...
});
```

---

### 5. Estilos CSS para o Toggle (src/routes/ui.ts ou theme.ts)

Adicionar estilos para o toggle switch visual:

```css
/* Toggle switch styling */
.form-label-toggle {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
}

.toggle-label-text {
  font-weight: 600;
  font-size: 13px;
}

.toggle-switch {
  appearance: none;
  -webkit-appearance: none;
  width: 44px;
  height: 24px;
  background: var(--form-input-border);
  border-radius: 12px;
  position: relative;
  cursor: pointer;
  transition: background-color 0.3s;
}

.toggle-switch:checked {
  background: var(--interactive-primary);
}

.toggle-switch::before {
  content: "";
  position: absolute;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: white;
  top: 3px;
  left: 3px;
  transition: transform 0.3s;
}

.toggle-switch:checked::before {
  transform: translateX(20px);
}

.toggle-switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

---

### 6. Validação de Canais (src/config/userChannels.ts)

Atualizar validação para permitir `useM3u8Link`:

```typescript
export function validateChannelData(channel: any): { valid: boolean; reason?: string } {
  // ... validações existentes ...

  if (channel.useM3u8Link !== undefined && typeof channel.useM3u8Link !== "boolean") {
    return { valid: false, reason: "useM3u8Link must be a boolean." };
  }

  return { valid: true };
}
```

---

### 7. Documentação e Logs

#### 7.1 Adicionar logs informativos

Em `src/browser/m3u8Capture.ts`:
- Log quando M3U8 é detectado
- Log quando timeout ocorre
- Log de erros de rede

Em `src/streaming/setup.ts`:
- Log quando modo M3U8 é ativado
- Log do M3U8 URL capturado
- Log de erros de setup

#### 7.2 Atualizar README.md

Adicionar seção sobre M3U8 capture:

```markdown
### M3U8 Link Capture

PrismCast can capture M3U8 links directly from network traffic instead of screen capture for better quality and performance.

To enable for a channel:
1. Go to Configuration → Channels
2. Add or edit a channel
3. Click "Show Advanced Options"
4. Enable "Use M3U8 Link" toggle
5. Save

**Requirements:**
- The site must load an M3U8 manifest in its network traffic
- Login may be required before the M3U8 link appears
- If M3U8 capture fails, the stream will return an error

**Benefits:**
- Higher video quality (direct source)
- Lower CPU usage (no screen capture)
- Reduced latency
```

---

## 🔄 Fluxo de Trabalho Detalhado

### Caso 1: M3U8 Ativado + Sucesso

```
1. Cliente → GET /hls/espn/stream.m3u8
2. ensureChannelStream("espn")
3. channel.useM3u8Link = true
4. setupStream(useM3u8Link: true)
5. Cria página temporária (sem captura)
6. captureM3u8FromNetwork():
   - Habilita Network.enable via CDP
   - Navega para espn.com
   - Aguarda login (waitForNetworkIdle)
   - Network.responseReceived detecta: https://espn.com/live.m3u8
7. Fecha página temporária
8. setupM3u8Stream():
   - FFmpeg -i https://espn.com/live.m3u8 → stdout
   - fMP4Segmenter processa stdout
   - Gera init.mp4 + segments
9. Cliente recebe stream.m3u8
10. Cliente baixa segments normalmente
```

### Caso 2: M3U8 Ativado + Falha

```
1. Cliente → GET /hls/espn/stream.m3u8
2. ensureChannelStream("espn")
3. channel.useM3u8Link = true
4. setupStream(useM3u8Link: true)
5. Cria página temporária
6. captureM3u8FromNetwork():
   - Navega para site
   - Timeout (15s) sem detectar M3U8
   - Retorna { success: false, reason: "No M3U8 detected" }
7. Fecha página temporária
8. throw StreamSetupError(503, "Could not capture M3U8")
9. Cliente recebe HTTP 503 Service Unavailable
10. Channels DVR mostra erro no cliente
```

### Caso 3: M3U8 Desativado (comportamento atual)

```
Fluxo normal de captura de tela permanece inalterado
```

---

## 🚨 Tratamento de Erros

### Códigos HTTP Recomendados

| Situação | Código | Mensagem |
|----------|--------|----------|
| M3U8 não detectado (timeout) | **503 Service Unavailable** | "Could not capture M3U8 link from [domain]. No M3U8 link detected in network traffic within timeout period." |
| Erro de navegação | **503 Service Unavailable** | "Could not capture M3U8 link from [domain]. Navigation failed." |
| M3U8 URL inválido | **500 Internal Server Error** | "Captured M3U8 URL is not accessible." |
| FFmpeg falha ao processar M3U8 | **500 Internal Server Error** | "Failed to process M3U8 stream." |
| Site requer login não completado | **503 Service Unavailable** | "M3U8 capture requires authentication. Please use Login mode first." |

### Retry Strategy

- **NÃO** fazer fallback automático para captura de tela
- Cliente (Channels DVR) pode retentar com backoff
- Use header `Retry-After: 30` para 503 errors

---

## 📄 Lista de Arquivos a Criar/Modificar

### ✅ Arquivos a CRIAR

1. **src/browser/m3u8Capture.ts** (NOVO)
   - `captureM3u8FromNetwork()`
   - `validateM3u8Url()`
   - `isM3u8Url()`

### 🔧 Arquivos a MODIFICAR

1. **src/types/index.ts**
   - Adicionar `useM3u8Link?: boolean` em `Channel`
   - Adicionar interface `M3u8CaptureResult`
   - Adicionar `useM3u8Link?` em `StreamSetupOptions`

2. **src/streaming/setup.ts**
   - Importar `captureM3u8FromNetwork`
   - Modificar `setupStream()` - adicionar branch para M3U8
   - Adicionar função `setupM3u8Stream()`
   - Adicionar interface `M3u8StreamSetupOptions`

3. **src/routes/config.ts**
   - Modificar `generateAdvancedFields()` - adicionar toggle
   - Atualizar `generateChannelRowHtml()`
   - Atualizar POST `/api/channels`
   - Atualizar PUT `/api/channels/:key`

4. **src/routes/ui.ts** (ou **src/routes/theme.ts**)
   - Adicionar estilos CSS para toggle switch

5. **src/config/userChannels.ts**
   - Atualizar `validateChannelData()` para aceitar `useM3u8Link`

6. **README.md**
   - Adicionar seção sobre M3U8 Link Capture

---

## 🧪 Testes Recomendados

### Testes Manuais

1. **Teste básico - Site com M3U8 claro**:
   - Adicionar canal YouTube Live com useM3u8Link=true
   - Verificar se M3U8 é capturado
   - Verificar se stream funciona

2. **Teste login - Site com autenticação**:
   - Adicionar canal ESPN+ com useM3u8Link=true
   - Usar botão "Login" primeiro
   - Depois iniciar stream
   - Verificar captura de M3U8

3. **Teste falha - Site sem M3U8**:
   - Criar canal com URL que não gera M3U8
   - Verificar erro 503
   - Verificar mensagem de erro clara

4. **Teste toggle UI**:
   - Adicionar canal, ativar toggle
   - Salvar, verificar persistência
   - Editar, verificar que toggle mantém estado

### Casos de Edge

1. M3U8 com query params: `?token=abc123`
2. Multiple M3U8s na página (master + variant)
3. M3U8 após redirect (302)
4. M3U8 com CORS headers

---

## 📊 Mapeamento de Responsabilidades

| Componente | Responsabilidade | Localização |
|------------|------------------|-------------|
| **Channel Type** | Armazenar flag `useM3u8Link` | `src/types/index.ts` |
| **UI Form** | Toggle visual para usuário | `src/routes/config.ts` |
| **M3U8 Capture** | Capturar link via CDP | `src/browser/m3u8Capture.ts` |
| **Stream Setup** | Decidir fluxo (M3U8 vs Screen) | `src/streaming/setup.ts` |
| **FFmpeg** | Baixar e processar M3U8 | `src/streaming/setup.ts` (setupM3u8Stream) |
| **Error Handling** | Retornar HTTP 503/500 | `src/streaming/setup.ts` |
| **Validation** | Validar dados do canal | `src/config/userChannels.ts` |

---

## ⚙️ Configurações Sugeridas

### Adicionar em CONFIG (src/config/index.ts)

```typescript
export interface M3u8Config {
  /**
   * Timeout for waiting for M3U8 link to appear in network traffic (ms).
   * Default: 15000 (15 seconds)
   */
  captureTimeout: number;

  /**
   * Whether to validate captured M3U8 URLs before use.
   * Default: true
   */
  validateUrls: boolean;
}

// Em Config interface:
export interface Config {
  // ... campos existentes ...
  m3u8: M3u8Config;
}

// Defaults:
export const M3U8_DEFAULTS: M3u8Config = {
  captureTimeout: 15000,
  validateUrls: true
};
```

### Variáveis de Ambiente

```bash
M3U8_CAPTURE_TIMEOUT=15000  # Timeout para captura (ms)
M3U8_VALIDATE_URLS=true     # Validar URLs capturadas
```

---

## 🎯 Etapas de Implementação (Ordem Sugerida)

### Fase 1: Estrutura Base
- [ ] 1.1 Atualizar tipos em `src/types/index.ts`
- [ ] 1.2 Criar `src/browser/m3u8Capture.ts` (esqueleto)
- [ ] 1.3 Adicionar estilos CSS para toggle

### Fase 2: Captura M3U8
- [ ] 2.1 Implementar `captureM3u8FromNetwork()`
- [ ] 2.2 Implementar `validateM3u8Url()`
- [ ] 2.3 Testar captura isolada

### Fase 3: Integração com Setup
- [ ] 3.1 Modificar `setupStream()` - adicionar branch M3U8
- [ ] 3.2 Implementar `setupM3u8Stream()`
- [ ] 3.3 Testar fluxo completo

### Fase 4: UI
- [ ] 4.1 Adicionar toggle em `generateAdvancedFields()`
- [ ] 4.2 Atualizar handlers POST/PUT
- [ ] 4.3 Testar UI - adicionar/editar/salvar

### Fase 5: Validação e Testes
- [ ] 5.1 Atualizar `validateChannelData()`
- [ ] 5.2 Testes manuais (casos de sucesso/falha)
- [ ] 5.3 Testes edge cases

### Fase 6: Documentação
- [ ] 6.1 Atualizar README.md
- [ ] 6.2 Adicionar comentários de código
- [ ] 6.3 Criar exemplos de uso

---

## 💡 Considerações Adicionais

### Segurança
- M3U8 URLs podem conter tokens de autenticação
- Não logar URLs completas (apenas domínio)
- Validar URLs antes de passar ao FFmpeg

### Performance
- Fechar página temporária imediatamente após captura
- M3U8 streams consomem menos CPU que screen capture
- FFmpeg pode ter overhead de rede

### Compatibilidade
- Sites com DRM não terão M3U8 capturável
- Alguns sites usam dash (.mpd) em vez de HLS
- Future: estender para DASH?

### Manutenção
- Patterns de M3U8 podem precisar atualização
- Sites podem detectar e bloquear headless browsers
- Timeout de 15s pode precisar ajuste

---

## 🔗 Referências

- [Chrome DevTools Protocol - Network Domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
- [FFmpeg HLS Documentation](https://ffmpeg.org/ffmpeg-formats.html#hls-2)
- [Puppeteer CDP Session](https://pptr.dev/api/puppeteer.cdpsession)
- [HLS RFC 8216](https://datatracker.ietf.org/doc/html/rfc8216)

---

## ✅ Checklist Final

Antes de considerar a implementação completa:

- [ ] Tipos definidos e exportados
- [ ] Módulo de captura M3U8 criado e testado
- [ ] Stream setup modificado com branches corretos
- [ ] UI com toggle funcional e persistente
- [ ] Validação de dados funcionando
- [ ] Estilos CSS aplicados
- [ ] Testes manuais passando (sucesso + falha)
- [ ] Logs informativos em todas as etapas
- [ ] Tratamento de erros com códigos HTTP corretos
- [ ] Documentação atualizada
- [ ] Código revisado e sem erros TypeScript

---

**Data de Criação**: Fevereiro 2026  
**Versão**: 1.0  
**Autor**: Análise de Implementação PrismCast
