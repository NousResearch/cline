#!/usr/bin/env npx tsx
import * as grpc from "@grpc/grpc-js"
import { ReflectionService } from "@grpc/reflection"
import * as fs from "fs"
import * as health from "grpc-health-check"
import * as os from "os"
import * as path from "path"
import { type DiffServiceServer, DiffServiceService } from "../src/generated/grpc-js/host/diff"
import { type EnvServiceServer, EnvServiceService } from "../src/generated/grpc-js/host/env"
import { type TestingServiceServer, TestingServiceService } from "../src/generated/grpc-js/host/testing"
import { type WindowServiceServer, WindowServiceService } from "../src/generated/grpc-js/host/window"
import { type WorkspaceServiceServer, WorkspaceServiceService } from "../src/generated/grpc-js/host/workspace"
import { getPackageDefinition } from "./proto-utils.mjs"

// Diff sessions for tracking file edits
interface DiffSession {
	originalPath: string
	content: string[] // Lines of content
	encoding: string
}

const diffSessions = new Map<string, DiffSession>()
let diffCounter = 0

export async function startTestHostBridgeServer() {
	const server = new grpc.Server()

	// Set up health check
	const healthImpl = new health.HealthImplementation({ "": "SERVING" })
	healthImpl.addToServer(server)

	// Add host bridge services using the mock implementations
	server.addService(WorkspaceServiceService, createMockService<WorkspaceServiceServer>("WorkspaceService"))
	server.addService(WindowServiceService, createMockService<WindowServiceServer>("WindowService"))
	server.addService(EnvServiceService, createMockService<EnvServiceServer>("EnvService"))
	server.addService(DiffServiceService, createMockService<DiffServiceServer>("DiffService"))
	server.addService(TestingServiceService, createMockService<TestingServiceServer>("TestingService"))

	try {
		// Load package definition for reflection service
		const packageDefinition = await getPackageDefinition()
		// Filter service names to only include host services
		const hostBridgeServiceNames = Object.keys(packageDefinition).filter(
			(name) => name.startsWith("host.") || name.startsWith("grpc.health"),
		)
		const reflection = new ReflectionService(packageDefinition, {
			services: hostBridgeServiceNames,
		})
		reflection.addToServer(server)
	} catch (error) {
		console.warn("HostBridge reflection disabled:", error)
	}

	const bindAddress = process.env.HOST_BRIDGE_ADDRESS || `127.0.0.1:26041`

	server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (err) => {
		if (err) {
			console.error(`Failed to bind test host bridge server to ${bindAddress}:`, err)
			process.exit(1)
		}
		server.start()
		console.log(`Test HostBridge gRPC server listening on ${bindAddress}`)
	})
}

/**
 * Creates a mock gRPC service implementation using Proxy
 * @param serviceName Name of the service for logging
 * @returns A proxy that implements the service interface
 */
function createMockService<T extends grpc.UntypedServiceImplementation>(serviceName: string): T {
	const handler: ProxyHandler<T> = {
		get(_target, prop) {
			// Return a function that handles the gRPC call
			return (call: any, callback: any) => {
				console.log(`Hostbridge: ${serviceName}.${String(prop)} called with:`, call.request)

				// Special cases that need specific return values
				switch (prop) {
					case "getWorkspacePaths":
						const workspaceDir = process.env.TEST_HOSTBRIDGE_WORKSPACE_DIR || "/test-workspace"
						callback(null, {
							paths: [workspaceDir],
						})
						return

					case "getMachineId":
						callback(null, {
							value: "fake-machine-id-" + os.hostname(),
						})
						return

					case "getTelemetrySettings":
						callback(null, {
							isEnabled: 2, // Setting.DISABLED
						})
						return

					case "clipboardReadText":
						callback(null, {
							value: "",
						})
						return

					case "getWebviewHtml":
						callback(null, {
							html: "<html><body>Fake Webview</body></html>",
						})
						return

					case "showTextDocument":
						callback(null, {
							document_path: call.request?.path || "",
							view_column: 1,
							is_active: true,
						})
						return

					case "openDiff": {
						// Real file operation: create a diff session
						const filePath = call.request?.path || ""
						const workspaceDir = process.env.TEST_HOSTBRIDGE_WORKSPACE_DIR || process.cwd()
						const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath)

						diffCounter++
						const diffId = `diff_${process.pid}_${diffCounter}`

						// Read existing file content or start empty
						let content: string[] = []
						try {
							if (fs.existsSync(fullPath)) {
								content = fs.readFileSync(fullPath, "utf8").split("\n")
							}
						} catch (err) {
							console.log(`[openDiff] Could not read ${fullPath}: ${err}`)
						}

						diffSessions.set(diffId, {
							originalPath: fullPath,
							content,
							encoding: "utf8",
						})

						console.log(`[openDiff] Created session ${diffId} for ${fullPath} (${content.length} lines)`)
						callback(null, { diff_id: diffId })
						return
					}

					case "getDocumentText":
						callback(null, {
							content: "",
						})
						return

					case "getOpenTabs":
					case "getVisibleTabs":
					case "showOpenDialogue":
						callback(null, {
							paths: [],
						})
						return

					case "getDiagnostics":
						callback(null, {
							file_diagnostics: [],
						})
						return

					case "applyEdits": {
						// Real file operation: apply edits to diff session
						const diffId = call.request?.diff_id
						const session = diffSessions.get(diffId)
						if (!session) {
							console.log(`[applyEdits] Session ${diffId} not found`)
							callback(null, {})
							return
						}

						const edits = call.request?.edits || []
						for (const edit of edits) {
							const startLine = edit.start_line ?? 0
							const endLine = edit.end_line ?? startLine
							const newContent = edit.content || ""
							const newLines = newContent.split("\n")

							// Replace lines from startLine to endLine with newContent
							session.content.splice(startLine, endLine - startLine + 1, ...newLines)
							console.log(
								`[applyEdits] Applied edit at lines ${startLine}-${endLine}: ${newLines.length} new lines`,
							)
						}

						callback(null, {})
						return
					}

					case "saveDocument": {
						// Real file operation: write content to disk
						const diffId = call.request?.diff_id
						const session = diffSessions.get(diffId)
						if (!session) {
							console.log(`[saveDocument] Session ${diffId} not found`)
							callback(null, {})
							return
						}

						try {
							// Ensure directory exists
							const dir = path.dirname(session.originalPath)
							if (!fs.existsSync(dir)) {
								fs.mkdirSync(dir, { recursive: true })
							}

							// Write content to file
							const content = session.content.join("\n")
							fs.writeFileSync(session.originalPath, content, session.encoding as BufferEncoding)
							console.log(`[saveDocument] Saved ${session.originalPath} (${content.length} bytes)`)
						} catch (err) {
							console.error(`[saveDocument] Failed to save ${session.originalPath}: ${err}`)
						}

						callback(null, {})
						return
					}

					case "closeDiff": {
						// Clean up diff session
						const diffId = call.request?.diff_id
						if (diffSessions.delete(diffId)) {
							console.log(`[closeDiff] Closed session ${diffId}`)
						}
						callback(null, {})
						return
					}

					// For streaming methods (like subscribeToTelemetrySettings)
					case "subscribeToTelemetrySettings":
						// Just end the stream immediately
						call.end()
						return
				}

				// Default: return empty object for all other methods
				callback(null, {})
			}
		},
	}

	return new Proxy({} as T, handler)
}

if (require.main === module) {
	startTestHostBridgeServer().catch((err) => {
		console.error("Failed to start test host bridge server:", err)
		process.exit(1)
	})
}
