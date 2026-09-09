/**
 * OpenDART HTTP 클라이언트
 *
 * Base: https://opendart.fss.or.kr/api/
 * 인증: 모든 요청에 `crtfc_key` 쿼리파라미터 필수
 * 응답: JSON (대부분) / ZIP (원문·corp_code·XBRL)
 * 요율: 일 20,000건 (키 단위 합산)
 *
 * [원격 배포용 수정]
 *  1) 타임아웃이 본문 수신까지 덮도록 수정. 이전 구현은 fetch() 가 헤더를 받는 순간
 *     finally 에서 clearTimeout 을 호출해, 그 뒤의 res.json()/arrayBuffer() 본문
 *     다운로드가 무제한으로 늘어졌다. 삼성전자 elestock 처럼 수 MB 응답에서
 *     MCP 클라이언트가 수 분간 행에 걸리는 원인.
 *  2) getJson 에 짧은 TTL 메모리 캐시 추가. insider_signal 과 get_major_holdings 가
 *     동일한 elestock.json 을 각각 호출하므로 중복 왕복을 없앤다.
 */

const DART_BASE_URL = "https://opendart.fss.or.kr/api";

export interface DartClientOptions {
  apiKey: string;
  /** JSON 요청 타임아웃 (ms, 본문 수신 포함). 기본 45s */
  timeout?: number;
  /** ZIP 요청 타임아웃 (ms, 본문 수신 포함). corp_code 덤프가 크다. 기본 180s */
  zipTimeout?: number;
  /** getJson 응답 캐시 TTL (ms). 0이면 비활성. 기본 5분 */
  cacheTtl?: number;
}

interface CacheEntry {
  at: number;
  value: unknown;
}

export class DartClient {
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly zipTimeout: number;
  private readonly cacheTtl: number;
  private readonly cache = new Map<string, CacheEntry>();
  /** 동일 URL 동시 요청 합치기 */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(opts: DartClientOptions) {
    this.apiKey = opts.apiKey;
    this.timeout = opts.timeout ?? 45_000;
    this.zipTimeout = opts.zipTimeout ?? 180_000;
    this.cacheTtl = opts.cacheTtl ?? 5 * 60_000;
  }

  /** JSON 엔드포인트 호출 (TTL 캐시 + 동시요청 합치기) */
  async getJson<T = unknown>(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = this.buildUrl(path, params);

    if (this.cacheTtl > 0) {
      const hit = this.cache.get(url);
      if (hit && Date.now() - hit.at < this.cacheTtl) return hit.value as T;

      const running = this.inflight.get(url);
      if (running) return running as Promise<T>;
    }

    const task = this.fetchJson<T>(path, url).then(
      (value) => {
        if (this.cacheTtl > 0) {
          this.cache.set(url, { at: Date.now(), value });
          this.pruneCache();
        }
        this.inflight.delete(url);
        return value;
      },
      (err) => {
        this.inflight.delete(url);
        throw err;
      },
    );

    if (this.cacheTtl > 0) this.inflight.set(url, task);
    return task;
  }

  private async fetchJson<T>(path: string, url: string): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        throw new Error(`DART ${path} → HTTP ${res.status}`);
      }
      // 본문 수신도 같은 타이머 아래에서 진행된다 (이 위치가 핵심)
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(
          `DART ${path} → ${this.timeout / 1000}s 타임아웃. 조회 범위를 좁혀 다시 시도하세요.`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** ZIP 엔드포인트 호출 (corp_code 덤프, 원문 XML, XBRL 등).
   *  DART 는 에러 시 Content-Type 은 zip 이지만 바디는 {"status":"013",...} JSON 을 돌려준다. */
  async getZip(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<Buffer> {
    const url = this.buildUrl(path, params);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.zipTimeout);
    let buf: Buffer;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        throw new Error(`DART ${path} → HTTP ${res.status}`);
      }
      const ab = await res.arrayBuffer();
      buf = Buffer.from(ab);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`DART ${path} → ${this.zipTimeout / 1000}s 타임아웃.`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    // PK\x03\x04 (zip local file header) 또는 PK\x05\x06 (empty zip) 으로 시작해야 정상
    if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return buf;
    // JSON 에러 응답 감지
    const head = buf.subarray(0, Math.min(512, buf.length)).toString("utf8");
    if (head.trimStart().startsWith("{")) {
      try {
        const err = JSON.parse(head) as { status?: string; message?: string };
        throw new Error(
          `DART ${path} → [${err.status ?? "?"}] ${err.message ?? head}`,
        );
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("DART ")) throw e;
      }
    }
    throw new Error(`DART ${path} → 비-ZIP 응답 (${buf.length}B): ${head.slice(0, 200)}`);
  }

  /** 캐시가 무한정 자라지 않도록 만료 항목 정리 (상한 200) */
  private pruneCache(): void {
    if (this.cache.size <= 200) return;
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (now - v.at >= this.cacheTtl) this.cache.delete(k);
    }
    while (this.cache.size > 200) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private buildUrl(
    path: string,
    params: Record<string, string | number | undefined>,
  ): string {
    const u = new URL(`${DART_BASE_URL}/${path}`);
    u.searchParams.set("crtfc_key", this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  }
}
