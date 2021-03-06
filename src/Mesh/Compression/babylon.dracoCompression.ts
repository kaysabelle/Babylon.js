declare var DracoDecoderModule: any;
declare var WebAssembly: any;

module BABYLON {
    /**
     * Configuration for Draco compression
     */
    export interface IDracoCompressionConfiguration {
        /**
         * Configuration for the JavaScript decoder or null if not available.
         */
        decoder: Nullable<{
            url: string;
        }>;

        /**
         * Configuration for the WebAssembly decoder or null if not available.
         */
        decoderWasm: Nullable<{
            binaryUrl: string;
            wrapperUrl: string;
        }>;
    }

    /**
     * Draco compression (https://google.github.io/draco/)
     */
    export class DracoCompression implements IDisposable {
        private static _DecoderModulePromise: Promise<any>;

        /**
         * Gets the configuration.
         */
        public static Configuration = DracoCompression._GetDefaultConfig();

        /**
         * Returns true if the decoder is available.
         */
        public static get DecoderAvailable(): boolean {
            return (
                typeof DracoDecoderModule !== "undefined" ||
                (typeof WebAssembly === "object" && !!DracoCompression.Configuration.decoderWasm) ||
                !!DracoCompression.Configuration.decoder
            );
        }

        /**
         * Constructor
         */
        constructor() {
        }

        /**
         * Stop all async operations and release resources.
         */
        public dispose(): void {
        }

        /**
         * Decode Draco compressed mesh data to vertex data.
         * @param data The array buffer view for the Draco compression data
         * @param attributes A map of attributes from vertex buffer kinds to Draco unique ids
         * @returns A promise that resolves with the decoded vertex data
         */
        public decodeMeshAsync(data: ArrayBufferView, attributes: { [kind: string]: number }): Promise<VertexData> {
            return DracoCompression._GetDecoderModule().then(wrappedModule => {
                const module = wrappedModule.module;
                const vertexData = new VertexData();

                const buffer = new module.DecoderBuffer();
                buffer.Init(data, data.byteLength);

                const decoder = new module.Decoder();
                let geometry: any;
                let status: any;

                try {
                    const type = decoder.GetEncodedGeometryType(buffer);
                    switch (type) {
                        case module.TRIANGULAR_MESH:
                            geometry = new module.Mesh();
                            status = decoder.DecodeBufferToMesh(buffer, geometry);
                            break;
                        case module.POINT_CLOUD:
                            geometry = new module.PointCloud();
                            status = decoder.DecodeBufferToPointCloud(buffer, geometry);
                            break;
                        default:
                            throw new Error(`Invalid geometry type ${type}`);
                    }

                    if (!status.ok() || !geometry.ptr) {
                        throw new Error(status.error_msg());
                    }

                    const numPoints = geometry.num_points();

                    if (type === module.TRIANGULAR_MESH) {
                        const numFaces = geometry.num_faces();
                        const faceIndices = new module.DracoInt32Array();
                        try {
                            const indices = new Uint32Array(numFaces * 3);
                            for (let i = 0; i < numFaces; i++) {
                                decoder.GetFaceFromMesh(geometry, i, faceIndices);
                                const offset = i * 3;
                                indices[offset + 0] = faceIndices.GetValue(0);
                                indices[offset + 1] = faceIndices.GetValue(1);
                                indices[offset + 2] = faceIndices.GetValue(2);
                            }
                            vertexData.indices = indices;
                        }
                        finally {
                            module.destroy(faceIndices);
                        }
                    }

                    for (const kind in attributes) {
                        const uniqueId = attributes[kind];
                        const attribute = decoder.GetAttributeByUniqueId(geometry, uniqueId);
                        const dracoData = new module.DracoFloat32Array();
                        try {
                            decoder.GetAttributeFloatForAllPoints(geometry, attribute, dracoData);
                            const babylonData = new Float32Array(numPoints * attribute.num_components());
                            for (let i = 0; i < babylonData.length; i++) {
                                babylonData[i] = dracoData.GetValue(i);
                            }
                            vertexData.set(babylonData, kind);
                        }
                        finally {
                            module.destroy(dracoData);
                        }
                    }
                }
                finally {
                    if (geometry) {
                        module.destroy(geometry);
                    }

                    module.destroy(decoder);
                    module.destroy(buffer);
                }

                return vertexData;
            });
        }

        private static _GetDecoderModule(): Promise<any> {
            if (!DracoCompression._DecoderModulePromise) {
                let promise: Promise<any>;
                let config: any = {};

                if (typeof DracoDecoderModule !== "undefined") {
                    promise = Promise.resolve();
                }
                else if (typeof WebAssembly === "object" && DracoCompression.Configuration.decoderWasm) {
                    promise = Promise.all([
                        DracoCompression._LoadScriptAsync(DracoCompression.Configuration.decoderWasm.wrapperUrl),
                        DracoCompression._LoadFileAsync(DracoCompression.Configuration.decoderWasm.binaryUrl).then(data => {
                            config.wasmBinary = data;
                        })
                    ]);
                }
                else if (DracoCompression.Configuration.decoder) {
                    promise = DracoCompression._LoadScriptAsync(DracoCompression.Configuration.decoder.url);
                }
                else {
                    throw new Error("Invalid decoder configuration");
                }

                DracoCompression._DecoderModulePromise = promise.then(() => {
                    return new Promise(resolve => {
                        config.onModuleLoaded = (decoderModule: any) => {
                            // decoderModule is Promise-like. Wrap before resolving to avoid loop.
                            resolve({ module: decoderModule });
                        };

                        DracoDecoderModule(config);
                    });
                });
            }

            return DracoCompression._DecoderModulePromise;
        }

        private static _LoadScriptAsync(url: string): Promise<void> {
            return new Promise((resolve, reject) => {
                Tools.LoadScript(url, () => {
                    resolve();
                }, message => {
                    reject(new Error(message));
                });
            });
        }

        private static _LoadFileAsync(url: string): Promise<ArrayBuffer> {
            return new Promise((resolve, reject) => {
                Tools.LoadFile(url, data => {
                    resolve(data as ArrayBuffer);
                }, undefined, undefined, true, (request, exception) => {
                    reject(exception);
                });
            });
        }

        private static _GetDefaultConfig(): IDracoCompressionConfiguration {
            const configuration: IDracoCompressionConfiguration = {
                decoder: null,
                decoderWasm: null
            };

            if (Tools.IsWindowObjectExist()) {
                let decoderUrl: Nullable<string> = null;
                let decoderWasmBinaryUrl: Nullable<string> = null;
                let decoderWasmWrapperUrl: Nullable<string> = null;

                for (let i = 0; i < document.scripts.length; i++) {
                    const type = document.scripts[i].type;
                    const src = document.scripts[i].src;
                    switch (type) {
                        case "text/x-draco-decoder": {
                            decoderUrl = src;
                            break;
                        }
                        case "text/x-draco-decoder-wasm-binary": {
                            decoderWasmBinaryUrl = src;
                            break;
                        }
                        case "text/x-draco-decoder-wasm-wrapper": {
                            decoderWasmWrapperUrl = src;
                            break;
                        }
                    }
                }

                if (decoderUrl) {
                    configuration.decoder = {
                        url: decoderUrl
                    };
                }

                if (decoderWasmWrapperUrl && decoderWasmBinaryUrl) {
                    configuration.decoderWasm = {
                        binaryUrl: decoderWasmBinaryUrl,
                        wrapperUrl: decoderWasmWrapperUrl
                    };
                }
            }

            return configuration;
        }
    }
}
