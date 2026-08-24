import { Container, getContainer } from "@cloudflare/containers";
import {
  OAuthProvider,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";

import { accessAuthHandler, allowedEmailSet } from "./access-auth.ts";
import {
  BackendError,
  callBackend,
  MAX_SOURCE_CHARACTERS,
  type BackendData,
  type BackendEndpoint,
} from "./backend-client.ts";
import type { Env } from "./env.ts";

const inputFormat = z
  .enum(["musicxml", "abc", "tiny_notation", "roman_text"])
  .describe("Format of the inline score source; file paths and URLs are not accepted.");
const outputFormat = z.enum(["musicxml", "midi", "lilypond"]);
const renderFormat = z.enum(["svg", "png", "pdf"]);
const source = z
  .string()
  .min(1)
  .max(MAX_SOURCE_CHARACTERS)
  .describe(`Inline score data, limited to ${MAX_SOURCE_CHARACTERS} characters.`);
const readOnlyAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} as const;

type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
  structuredContent?: BackendData;
};

type ToolContent =
  | { data: string; mimeType: string; type: "image" }
  | {
      resource: {
        blob: string;
        mimeType: string;
        uri: string;
      };
      type: "resource";
    }
  | {
      resource: {
        mimeType: string;
        text: string;
        uri: string;
      };
      type: "resource";
    }
  | { text: string; type: "text" };

interface Artifact {
  content: string;
  contentType: string;
  encoding: "base64" | "utf-8";
  outputFormat: string;
  size: number;
}

class ToolAuthorizationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ToolAuthorizationError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Private Linux container for music21 and LilyPond execution.
 *
 * This class was drafted with AI assistance. It has no public route: all calls
 * pass through the OAuth-protected MCP tools and their bounded schemas.
 */
export class Music21Container extends Container {
  defaultPort = 8080;
  enableInternet = false;
  pingEndpoint = "localhost/health";
  sleepAfter = "10m";

  override onError(error: unknown): void {
    console.error(
      "music21 container error",
      error instanceof Error ? error.name : "UnknownError",
    );
    throw error;
  }
}

/**
 * Construct a fresh stateless MCP SDK v2 server for one protocol request.
 *
 * The tool façade was drafted with AI assistance and exposes a deliberately
 * bounded subset of music21 rather than arbitrary Python or filesystem access.
 */
function createServer(env: Env, hasMcpScope: boolean): McpServer {
  const server = new McpServer({ name: "music21", version: "0.1.0" });

  server.registerTool(
    "inspect_score",
    {
      annotations: readOnlyAnnotations,
      description:
        "Parse inline notation and return bounded structural metadata about the score.",
      inputSchema: z.object({ inputFormat, source }).strict(),
    },
    async ({ inputFormat: format, source: score }) =>
      invoke(env, hasMcpScope, "/v1/inspect", {
        inputFormat: format,
        source: score,
      }),
  );

  server.registerTool(
    "analyse_score",
    {
      annotations: readOnlyAnnotations,
      description:
        "Analyse an inline score for key, ambitus, and/or pitch-class distribution.",
      inputSchema: z.object({
        analyses: z
          .array(z.enum(["key", "ambitus", "pitch_class_histogram"]))
          .min(1)
          .max(3)
          .refine((values) => new Set(values).size === values.length, {
            message: "analyses must not contain duplicates",
          })
          .optional(),
        inputFormat,
        source,
      }).strict(),
    },
    async ({ analyses, inputFormat: format, source: score }) =>
      invoke(env, hasMcpScope, "/v1/analyse", {
        analyses,
        inputFormat: format,
        source: score,
      }),
  );

  server.registerTool(
    "transpose_score",
    {
      annotations: readOnlyAnnotations,
      description:
        "Transpose an inline score by a music21 interval and return a converted artefact.",
      inputSchema: z.object({
        inputFormat,
        interval: z.union([
          z.number().int().min(-48).max(48),
          z
            .string()
            .trim()
            .regex(/^-?[A-Za-z][A-Za-z0-9+#-]{0,11}$/),
        ]).describe("A semitone count from -48 to 48, or an interval such as M3, -m2, or P5."),
        outputFormat,
        source,
      }).strict(),
    },
    async ({ inputFormat: format, interval, outputFormat: output, source: score }) =>
      invoke(env, hasMcpScope, "/v1/transpose", {
        inputFormat: format,
        interval,
        outputFormat: output,
        source: score,
      }),
  );

  server.registerTool(
    "convert_score",
    {
      annotations: readOnlyAnnotations,
      description:
        "Convert an inline score to MusicXML, MIDI, or LilyPond without arbitrary file access.",
      inputSchema: z.object({ inputFormat, outputFormat, source }).strict(),
    },
    async ({ inputFormat: format, outputFormat: output, source: score }) =>
      invoke(env, hasMcpScope, "/v1/convert", {
        inputFormat: format,
        outputFormat: output,
        source: score,
      }),
  );

  server.registerTool(
    "render_score",
    {
      annotations: readOnlyAnnotations,
      description:
        "Render every page of an inline score as SVG or PNG, or render one PDF artefact.",
      inputSchema: z.object({ inputFormat, outputFormat: renderFormat, source }).strict(),
    },
    async ({ inputFormat: format, outputFormat: output, source: score }) =>
      invoke(env, hasMcpScope, "/v1/render", {
        inputFormat: format,
        outputFormat: output,
        source: score,
      }),
  );

  return server;
}

async function invoke(
  env: Env,
  hasMcpScope: boolean,
  endpoint: BackendEndpoint,
  payload: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    requireAllowedIdentity(env, hasMcpScope);
    const container = getContainer(env.MUSIC21_CONTAINER, "music21-primary");
    const data = await callBackend(
      (request) => container.fetch(request),
      endpoint,
      payload,
    );
    return successfulToolResult(data);
  } catch (error) {
    let failure: { code: string; message: string; status: number };
    if (error instanceof BackendError || error instanceof ToolAuthorizationError) {
      failure = { code: error.code, message: error.message, status: error.status };
    } else {
      console.error(
        "music21 tool invocation failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      failure = {
        code: "internal_error",
        message: "The music21 tool could not complete the request",
        status: 500,
      };
    }
    return {
      content: [{ text: JSON.stringify({ error: failure, ok: false }), type: "text" }],
      isError: true,
    };
  }
}

function successfulToolResult(data: BackendData): ToolResult {
  const artifacts = extractArtifacts(data);
  if (artifacts.length === 0) {
    return {
      content: [{ text: JSON.stringify(data), type: "text" }],
      structuredContent: data,
    };
  }

  const metadata = withoutArtifactContent(data);
  const content: ToolContent[] = [
    { text: JSON.stringify(metadata), type: "text" },
  ];
  for (const [index, artifact] of artifacts.entries()) {
    const encoded = artifact.encoding === "base64"
      ? artifact.content
      : utf8ToBase64(artifact.content);
    if (artifact.contentType === "image/png" || artifact.contentType === "image/svg+xml") {
      content.push({ data: encoded, mimeType: artifact.contentType, type: "image" });
      continue;
    }
    if (artifact.encoding === "base64") {
      content.push({
        resource: {
          blob: artifact.content,
          mimeType: artifact.contentType,
          uri: artifactUri(artifact, index),
        },
        type: "resource",
      });
    } else {
      content.push({
        resource: {
          mimeType: artifact.contentType,
          text: artifact.content,
          uri: artifactUri(artifact, index),
        },
        type: "resource",
      });
    }
  }
  return { content, structuredContent: metadata };
}

function extractArtifacts(data: BackendData): Artifact[] {
  const candidates: unknown[] = [];
  if (data.artifact !== undefined) {
    candidates.push(data.artifact);
  }
  if (Array.isArray(data.artifacts)) {
    candidates.push(...data.artifacts);
  }
  return candidates.filter(isArtifact);
}

function isArtifact(value: unknown): value is Artifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.content === "string" &&
    typeof candidate.contentType === "string" &&
    (candidate.encoding === "base64" || candidate.encoding === "utf-8") &&
    typeof candidate.outputFormat === "string" &&
    typeof candidate.size === "number"
  );
}

function withoutArtifactContent(data: BackendData): BackendData {
  const metadata: BackendData = { ...data };
  if (isArtifact(metadata.artifact)) {
    const { content: _content, ...artifactMetadata } = metadata.artifact;
    metadata.artifact = artifactMetadata;
  }
  if (Array.isArray(metadata.artifacts)) {
    metadata.artifacts = metadata.artifacts.map((artifact) => {
      if (!isArtifact(artifact)) {
        return artifact;
      }
      const { content: _content, ...artifactMetadata } = artifact;
      return artifactMetadata;
    });
  }
  return metadata;
}

function artifactUri(artifact: Artifact, index: number): string {
  const extension = artifact.outputFormat.replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "bin";
  return `music21://result/${index + 1}.${extension}`;
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 16_384));
  }
  return btoa(binary);
}

function requireAllowedIdentity(env: Env, hasMcpScope: boolean): void {
  const auth = getMcpAuthContext();
  const email = auth?.props?.email;
  if (typeof email !== "string") {
    throw new ToolAuthorizationError("Authentication is required", 401, "not_authorized");
  }
  if (!allowedEmailSet(env.ALLOWED_EMAILS).has(email.trim().toLowerCase())) {
    throw new ToolAuthorizationError("This identity is not permitted", 403, "identity_not_allowed");
  }
  if (!hasMcpScope) {
    throw new ToolAuthorizationError("The mcp OAuth scope is required", 403, "insufficient_scope");
  }
}

const apiHandler = {
  fetch(request, env, context): Promise<Response> {
    const handler = createMcpHandler((requestContext) =>
      createServer(env, requestContext.authInfo?.scopes.includes("mcp") ?? false));
    return handler(request, env, context);
  },
} satisfies Pick<Required<ExportedHandler<Env>>, "fetch">;

const oauthOptions: OAuthProviderOptions<Env> = {
  accessTokenTTL: 60 * 60,
  allowPlainPKCE: false,
  apiHandler,
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/oauth/register",
  clientRegistrationTTL: 90 * 24 * 60 * 60,
  defaultHandler: accessAuthHandler,
  disallowPublicClientRegistration: false,
  onError(error) {
    console.error("OAuth provider error", error.code, error.status);
  },
  refreshTokenTTL: 30 * 24 * 60 * 60,
  resourceMetadata: {
    bearer_methods_supported: ["header"],
    resource_name: "music21 MCP",
    scopes_supported: ["mcp"],
  },
  scopesSupported: ["mcp", "offline_access"],
  tokenEndpoint: "/oauth/token",
};

export default new OAuthProvider(oauthOptions);
