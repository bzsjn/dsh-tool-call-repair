/** Public configuration accepted from `cordis.patch.yml`. */
export interface Config {
    /** Retry budget per turn+step. `0` disables retrying but keeps logging. */
    maxRetries?: number;
    /** Failure codes eligible for retry. Defaults to `MALFORMED_RESPONSE`. */
    codes?: string[];
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
    signal?: {
        aborted?: boolean;
    };
}
/** Downstream decision returned by another recovery hook. */
export type RequestErrorAction = {
    kind: 'retry';
} | undefined;
/** The subset of the cordis context this plugin uses. */
export interface PluginContext {
    logger?: {
        warn?: (message: string) => void;
    };
    on(event: 'agent/request-error', listener: (payload: RequestErrorPayload, next: () => Promise<RequestErrorAction>) => Promise<RequestErrorAction>): void;
}
/** Plugin entry id used by the plugin manager. */
export declare const name = "tool-call-repair";
export declare function apply(ctx: PluginContext, config?: Config): void;