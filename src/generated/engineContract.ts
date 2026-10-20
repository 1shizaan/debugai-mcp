// GENERATED from apps/engine/openapi.json by apps/api/scripts/engine-types.mjs. Do not edit.
// To change it, change the engine's model, then run
//   cd apps/engine && python scripts/export_openapi.py
//   cd apps/api && npm run engine-types
// and fix what tsc then finds in the callers. CI fails while they disagree.

export interface paths {
    "/api/v1/admin/cleanup/{project_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Cleanup Project
         * @description Delete all embeddings for a specific project.
         */
        delete: operations["cleanup_project_api_v1_admin_cleanup__project_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/cleanup/list": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Projects
         * @description List all indexed projects and their chunk counts.
         */
        get: operations["list_projects_api_v1_admin_cleanup_list_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/debug": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Debug Error */
        post: operations["debug_error_api_v1_debug_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/index/{project_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Index */
        delete: operations["delete_index_api_v1_index__project_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/index/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Index File */
        post: operations["index_file_api_v1_index_files_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/index/stats/{project_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Index Stats */
        get: operations["index_stats_api_v1_index_stats__project_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/memory/lookup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Memory Lookup */
        post: operations["memory_lookup_api_v1_memory_lookup_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/scan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Scan */
        post: operations["scan_api_v1_scan_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Health */
        get: operations["health_health_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Health Live
         * @description Is the process serving. Looks at nothing else, on purpose.
         *
         *     This is what Railway's healthcheckPath and the image's HEALTHCHECK probe
         *     (review K15). /health below answers 503 when Redis is down or the Anthropic
         *     key is missing, which is the right answer for a status page and the wrong
         *     one for a deploy gate: a Redis blip during a rollout would refuse to promote
         *     a healthy new build, or restart a healthy running one.
         */
        get: operations["health_live_health_live_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/llm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Health Llm
         * @description Deep LLM health check — makes real API calls to both providers.
         *     Use sparingly (costs tokens). Not called by the keepalive ping.
         *     Returns: { "claude": "ok"|"error", "claude_models": {model_id: "ok"|"error"},
         *                "openai": "ok"|"error"|"not_configured" }
         *     Requires X-Engine-Secret header — same guard as all other engine endpoints.
         */
        get: operations["health_llm_health_llm_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** DebugRequest */
        DebugRequest: {
            /** Cache Scope */
            cache_scope?: string | null;
            /** Caller */
            caller?: string | null;
            /** Capture Source */
            capture_source?: string | null;
            /**
             * Code Snippet
             * @default
             */
            code_snippet?: string | null;
            /**
             * Code Snippet Start Line
             * @default 1
             */
            code_snippet_start_line?: number;
            /** Context Slice */
            context_slice?: Record<string, unknown> | null;
            /** Error Message */
            error_message: string;
            /**
             * File Path
             * @default
             */
            file_path?: string | null;
            /**
             * Framework Hint
             * @default unknown
             */
            framework_hint?: string | null;
            /**
             * Language
             * @default unknown
             */
            language?: string;
            /** Network Capture */
            network_capture?: Record<string, unknown> | null;
            /** Project Id */
            project_id?: string | null;
            /** Repro Command */
            repro_command?: string | null;
            /** Repro Expected */
            repro_expected?: string | null;
            /**
             * User Tier
             * @default free
             */
            user_tier?: string | null;
            /** Workspace Facts */
            workspace_facts?: Record<string, unknown> | null;
        };
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /** IndexFileRequest */
        IndexFileRequest: {
            /** Content */
            content: string;
            /** File Path */
            file_path: string;
            /**
             * Language
             * @default unknown
             */
            language?: string;
            /** Project Id */
            project_id: string;
            /**
             * User Tier
             * @default free
             */
            user_tier?: string | null;
        };
        /** MemoryLookupRequest */
        MemoryLookupRequest: {
            /** Error Message */
            error_message: string;
            /** Project Id */
            project_id?: string | null;
        };
        /** ScanCandidateIn */
        ScanCandidateIn: {
            /**
             * Churn
             * @default 0
             */
            churn?: number;
            /** Path */
            path: string;
            /**
             * Size Bytes
             * @default 0
             */
            size_bytes?: number;
        };
        /** ScanRequest */
        ScanRequest: {
            /** Candidates */
            candidates?: components["schemas"]["ScanCandidateIn"][];
            /**
             * Cap
             * @default 10
             */
            cap?: number;
            /**
             * First Scan
             * @default false
             */
            first_scan?: boolean;
            /** Project Id */
            project_id: string;
            /**
             * Stop After
             * @default 0
             */
            stop_after?: number;
            /**
             * User Tier
             * @default free
             */
            user_tier?: string | null;
        };
        /** ValidationError */
        ValidationError: {
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type DebugRequest = components['schemas']['DebugRequest'];
export type HttpValidationError = components['schemas']['HTTPValidationError'];
export type IndexFileRequest = components['schemas']['IndexFileRequest'];
export type MemoryLookupRequest = components['schemas']['MemoryLookupRequest'];
export type ScanCandidateIn = components['schemas']['ScanCandidateIn'];
export type ScanRequest = components['schemas']['ScanRequest'];
export type ValidationError = components['schemas']['ValidationError'];
export type $defs = Record<string, never>;
export interface operations {
    cleanup_project_api_v1_admin_cleanup__project_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_projects_api_v1_admin_cleanup_list_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    debug_error_api_v1_debug_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DebugRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_index_api_v1_index__project_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    index_file_api_v1_index_files_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IndexFileRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    index_stats_api_v1_index_stats__project_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    memory_lookup_api_v1_memory_lookup_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemoryLookupRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    scan_api_v1_scan_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ScanRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    health_health_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    health_live_health_live_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    health_llm_health_llm_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
}

// ── What a client sends the API ─────────────────────────────────────────────
// The API forwards these bodies to the engine under the same field names
// (routes/debug.ts buildEnginePayload, index.ts POST /api/engine/index/files,
// routes/memoryLookup.ts, routes/scan.ts). A client's body is the engine's
// request less what the API sets itself: the authenticated user's cache scope
// and tier, the caller label, and the scan's size and first-scan treatment.
// The engine's three loose dicts are any object here, so a client can pass its
// own named shape (an interface has no index signature to match Record).
type OpenObjects = 'network_capture' | 'context_slice' | 'workspace_facts';
export type ApiDebugBody = Omit<DebugRequest, 'cache_scope' | 'user_tier' | 'caller' | OpenObjects> & {
    [K in OpenObjects]?: object | null;
};
export type ApiIndexFileBody = Omit<IndexFileRequest, 'user_tier'>;
export type ApiMemoryLookupBody = MemoryLookupRequest;
export type ApiScanBody = Omit<ScanRequest, 'user_tier' | 'cap' | 'first_scan' | 'stop_after'>;
