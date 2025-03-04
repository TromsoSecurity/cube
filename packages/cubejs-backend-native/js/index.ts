/* eslint-disable import/no-dynamic-require,global-require */
import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';

export interface BaseMeta {
    // postgres or mysql
    protocol: string,
    // always sql
    apiType: string,
    // Application name, for example Metabase
    appName?: string,
}

export interface LoadRequestMeta extends BaseMeta {
    // Security Context switching
    changeUser?: string,
}

export interface Request<Meta> {
    id: string,
    meta: Meta,
}

export interface CheckAuthResponse {
    password: string | null,
    superuser: boolean
}

export interface CheckAuthPayload {
    request: Request<undefined>,
    user: string | null
}

export interface SessionContext {
    user: string | null,
    superuser: boolean,
}

export interface LoadPayload {
    request: Request<LoadRequestMeta>,
    session: SessionContext,
    query: any,
}

export interface MetaPayload {
    request: Request<undefined>,
    session: SessionContext,
}

export type SQLInterfaceOptions = {
    port?: number,
    pgPort?: number,
    nonce?: string,
    checkAuth: (payload: CheckAuthPayload) => CheckAuthResponse | Promise<CheckAuthResponse>,
    load: (payload: LoadPayload) => unknown | Promise<unknown>,
    meta: (payload: MetaPayload) => unknown | Promise<unknown>,
    stream: (payload: LoadPayload) => unknown | Promise<unknown>,
};

function loadNative() {
  // Development version
  if (fs.existsSync(path.join(__dirname, '/../../index.node'))) {
    return require(path.join(__dirname, '/../../index.node'));
  }

  if (fs.existsSync(path.join(__dirname, '/../../native/index.node'))) {
    return require(path.join(__dirname, '/../../native/index.node'));
  }

  throw new Error(
    `Unable to load @cubejs-backend/native, probably your system (${process.arch}-${process.platform}) with Node.js ${process.version} is not supported.`
  );
}

export function isSupported(): boolean {
  return fs.existsSync(path.join(__dirname, '/../../index.node')) || fs.existsSync(path.join(__dirname, '/../../native/index.node'));
}

function wrapNativeFunctionWithChannelCallback(
  fn: (extra: any) => unknown | Promise<unknown>
) {
  return async (extra: any, channel: any) => {
    try {
      const result = await fn(JSON.parse(extra));

      if (process.env.CUBEJS_NATIVE_INTERNAL_DEBUG) {
        console.debug('[js] channel.resolve', {
          result
        });
      }

      if (!result) {
        channel.resolve('');
      } else {
        channel.resolve(JSON.stringify(result));
      }
    } catch (e: any) {
      if (process.env.CUBEJS_NATIVE_INTERNAL_DEBUG) {
        console.debug('[js] channel.reject', {
          e
        });
      }
      try {
        channel.reject(e.message || 'Unknown JS exception');
      } catch (rejectErr: unknown) {
        if (process.env.CUBEJS_NATIVE_INTERNAL_DEBUG) {
          console.debug('[js] channel.reject exception', {
            e: rejectErr
          });
        }
      }

      // throw e;
    }
  };
}

const errorString = (err: any) => err.error ||
    err.message ||
    err.stack?.toString() ||
    (typeof err === 'string' ? err.toString() : JSON.stringify(err));

// TODO: Refactor - define classes
function wrapNativeFunctionWithStream(
  fn: (extra: any) => unknown | Promise<unknown>
) {
  const chunkLength = parseInt(
    process.env.CUBEJS_DB_QUERY_STREAM_HIGH_WATER_MARK || '8192',
    10
  );
  return async (extra: any, writer: any) => {
    let streamResponse: any;
    try {
      streamResponse = await fn(JSON.parse(extra));
      if (streamResponse && streamResponse.stream) {
        writer.start();

        let chunkBuffer: any[] = [];
        const writable = new Writable({
          objectMode: true,
          highWaterMark: chunkLength,
          write(row: any, encoding: BufferEncoding, callback: (error?: (Error | null)) => void) {
            chunkBuffer.push(row);
            if (chunkBuffer.length < chunkLength) {
              callback(null);
            } else {
              const toSend = chunkBuffer;
              chunkBuffer = [];
              writer.chunk(toSend, callback);
            }
          },
          final(callback: (error?: (Error | null)) => void) {
            const end = (err: any) => {
              if (err) {
                callback(err);
              } else {
                writer.end(callback);
              }
            };
            if (chunkBuffer.length > 0) {
              const toSend = chunkBuffer;
              chunkBuffer = [];
              writer.chunk(toSend, end);
            } else {
              end(null);
            }
          },
          destroy(error: Error | null, callback: (error: (Error | null)) => void) {
            if (error) {
              writer.reject(errorString(error));
            }
            callback(null);
          }
        });
        streamResponse.stream.pipe(writable);
        streamResponse.stream.on('error', (err: any) => {
          writable.destroy(err);
        });
      } else {
        throw new Error('Expected stream but nothing returned');
      }
    } catch (e: any) {
      if (!!streamResponse && !!streamResponse.stream) {
        streamResponse.stream.destroy(e);
      }
      writer.reject(errorString(e));
    }
  };
}

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export const setupLogger = (logger: (extra: any) => unknown, logLevel: LogLevel): void => {
  const native = loadNative();
  native.setupLogger({ logger: wrapNativeFunctionWithChannelCallback(logger), logLevel });
};

export const isFallbackBuild = (): boolean => {
  const native = loadNative();
  return native.isFallbackBuild();
};

export type SqlInterfaceInstance = { __typename: 'sqlinterfaceinstance' };

export const registerInterface = async (options: SQLInterfaceOptions): Promise<SqlInterfaceInstance> => {
  if (typeof options !== 'object' && options == null) {
    throw new Error('Argument options must be an object');
  }

  if (typeof options.checkAuth !== 'function') {
    throw new Error('options.checkAuth must be a function');
  }

  if (typeof options.load !== 'function') {
    throw new Error('options.load must be a function');
  }

  if (typeof options.meta !== 'function') {
    throw new Error('options.meta must be a function');
  }

  if (typeof options.stream !== 'function') {
    throw new Error('options.stream must be a function');
  }

  const native = loadNative();
  return native.registerInterface({
    ...options,
    checkAuth: wrapNativeFunctionWithChannelCallback(options.checkAuth),
    load: wrapNativeFunctionWithChannelCallback(options.load),
    meta: wrapNativeFunctionWithChannelCallback(options.meta),
    stream: wrapNativeFunctionWithStream(options.stream),
  });
};

export const shutdownInterface = async (instance: SqlInterfaceInstance): Promise<void> => {
  const native = loadNative();

  await native.shutdownInterface(instance);

  await new Promise((resolve) => setTimeout(resolve, 2000));
};

export interface PyConfiguration {
    checkAuth?: (req: unknown, authorization: string) => Promise<void>
    queryRewrite?: (query: unknown, ctx: unknown) => Promise<unknown>
    contextToApiScopes?: () => Promise<string[]>
}

export const pythonLoadConfig = async (content: string, options: { fileName: string }): Promise<PyConfiguration> => {
  if (isFallbackBuild()) {
    throw new Error('Python is not supported in fallback build');
  }

  const native = loadNative();
  const config = await native.pythonLoadConfig(content, options);

  if (config.checkAuth) {
    const nativeCheckAuth = config.checkAuth;
    config.checkAuth = async (req: any, authorization: string) => nativeCheckAuth(
      // Req is a large object, let's simplify it
      {
        url: req.url,
        method: req.method,
        headers: req.headers,
      },
      authorization
    );
  }

  return config;
};

export type PythonCtx = {
    __type: 'PythonCtx'
} & {
    [key: string]: Function
};

export interface JinjaEngine {
    loadTemplate(templateName: string, templateContent: string): void;
    renderTemplate(templateName: string, context: unknown, pythonContext: PythonCtx | null): string;
}

export class NativeInstance {
    protected native: any | null = null;

    protected getNative(): any {
      if (this.native) {
        return this.native;
      }

      this.native = loadNative();

      return this.native;
    }

    public newJinjaEngine(options: { debugInfo?: boolean }): JinjaEngine {
      if (isFallbackBuild()) {
        throw new Error('Python (newJinjaEngine) is not supported in fallback build');
      }

      return this.getNative().newJinjaEngine(options);
    }

    public loadPythonContext(fileName: string, content: unknown): Promise<PythonCtx> {
      if (isFallbackBuild()) {
        throw new Error('Python (loadPythonContext) is not supported in fallback build');
      }

      return this.getNative().pythonLoadModel(fileName, content);
    }
}
