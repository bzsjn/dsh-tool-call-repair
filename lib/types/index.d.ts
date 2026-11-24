/** Public configuration accepted from `cordis.patch.yml`. */
export interface Config {
    /** 工具修复：参数 JSON 没写完的 tool-call 也把块关掉，让本轮正常收尾。 */
    '工具修复'?: boolean;
    /** 自动续写：正文被 max-tokens 截断后自动再要一段。 */
    '自动续写'?: boolean;
    /** 续写轮数：自动续写的上限。 */
    '续写轮数'?: number;
    /** 空响应修复：上游回 stop 却零内容时转成 EMPTY_RESPONSE 交给重试层。 */
    '空响应修复'?: boolean;
    /** 空响应次数：连续空响应的重试上限，0 表示不重试。 */
    '空响应次数'?: number;
    /** 退化检测：思考流连续出现纯应答短句时截断本轮。 */
    '退化检测'?: boolean;
    /** 退化阈值：连续几次算复读。 */
    '退化阈值'?: number;
    /** 退化词表：整行匹配的填充短句表。 */
    '退化词表'?: string[];
    /** 退化续跑：截断后在本轮边界推一条输入让本轮继续。 */
    '退化续跑'?: boolean;
    /** 退化续跑文案：续跑时注入的正文。 */
    '退化续跑文案'?: string;
    /** 退化续跑上限：同一轮最多续跑几次。 */
    '退化续跑上限'?: number;
    /** 历史清洗：发请求前处理历史里 content 为空的 assistant 消息。 */
    '历史清洗'?: boolean;
    /** 历史清洗占位：true 替换成占位文本，false 直接剔除。 */
    '历史清洗占位'?: boolean;
    /** 历史清洗文本：占位文本正文。 */
    '历史清洗文本'?: string;
    /** 重试次数：同一 step 的重试预算。 */
    '重试次数'?: number;
    /** token 上限：正文累计超过后主动收口，0 表示不限。 */
    'token上限'?: number;
    /** 每轮重试总上限。 */
    maxRetriesPerTurn?: number;
    /** 允许重试的失败码，`['*']` 表示全部。 */
    codes?: string[];
    /** 重试退避起始毫秒。 */
    initialDelayMs?: number;
    /** 重试退避上限毫秒。 */
    maxDelayMs?: number;
    /** 退避抖动比例。 */
    jitterRatio?: number;
}

/** Payload delivered by the `agent/request-error` waterfall. */
export interface RequestErrorPayload {
    agent?: object;
    turn?: number;
    step?: number;
    provider?: string;
    failure?: {
        code?: string;
        message?: string;
    };
    retryPolicy?: {
        mode?: 'normal' | 'always';
        maxRetries?: number;
    };
    signal?: {
        aborted?: boolean;
    };
}

/** Downstream decision returned by another recovery hook. */
export type RequestErrorAction = { kind: 'retry' } | undefined;

/** Minimal shape of the messages this plugin inspects. */
export interface MessageLike {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }> | null;
    [key: string]: unknown;
}

/** Pre-step decision carrying the message list about to be sent. */
export interface PreStepDecision {
    kind?: string;
    messages?: MessageLike[];
    [key: string]: unknown;
}

/** The subset of the cordis context this plugin uses. */
export interface PluginContext {
    logger?: {
        warn?: (message: string) => void;
        info?: (message: string) => void;
    };
    on(event: 'llm/stream', listener: (options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>, options?: { global?: boolean }): void;
    on(event: 'agent/request-error', listener: (payload: RequestErrorPayload, next: () => Promise<RequestErrorAction>) => Promise<RequestErrorAction>): void;
    on(event: 'agent/pre-step', listener: (payload: { turn?: number; step?: number }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>): void;
    on(event: 'agent/turn-stopping', listener: (payload: { agent?: object }) => void): void;
}

/** Plugin entry id used by the plugin manager. */
export declare const name = "tool-call-repair";
export declare function apply(ctx: PluginContext, config?: Config): void;
