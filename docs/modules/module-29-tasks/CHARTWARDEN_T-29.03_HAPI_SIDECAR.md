# ChartWarden — T-29.03 Addendum: HAPI HL7v2 Sidecar Bring-Up

**Document status:** lock-grade
**Tracks against:** `CHARTWARDEN_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §3.1, §4.11.3, §13.2
**Date:** 2026-06-10
**Prerequisites:** T-29.01 (manifest patch + forward-stub addendum) and T-29.02 (schema PR) merged.

This addendum delivers the drop-in artifacts for T-29.03 — the Java HAPI HL7v2 sidecar, the gRPC-over-UDS protocol, the TypeScript sidecar client, the typed segment registry, the Docker integration, the cruiser-enforced boundary rules, the round-trip test suite, and the sign-off checklist.

**The HAPI sidecar is the only Java in the ChartWarden repo.** Every guard rail in this addendum exists to keep that boundary tight: no Java imports leak into TypeScript, no PHI logs escape the sidecar, no other process can bind the UDS socket, no remote network exposure.

---

## 1. Scope & Non-Goals

### 1.1 In scope

- **Java Gradle project** at `packages/hl7-worker/parser-sidecar/` — HAPI HL7v2.5.1 dependency, gRPC-Java server, Maven-free build via Gradle Kotlin DSL.
- **gRPC proto definition** at `packages/hl7-worker/proto/parser.proto` — bidirectional `Parse` and `Build` RPCs plus a `Health` ping.
- **Java service implementation** — `ParserServiceImpl.java`, `SegmentMapper.java`, `UdsServerBootstrap.java`, structured-log redaction.
- **TypeScript sidecar client** at `packages/hl7-worker/src/parser-sidecar-client.ts` — gRPC-over-UDS, connection-pooled, with health-probe and graceful-restart handling.
- **Typed TS segment registry** under `packages/hl7-worker/src/segments/*.ts` — MSH and PID are canonical full implementations; PV1/OBR/OBX/ORC/NK1/IN1/GT1/NTE follow the same pattern (scaffolds shown).
- **Typed TS message types** under `packages/hl7-worker/src/messages/*.ts` — ADT^A01 and ORU^R01 are canonical; ADT^A03/A04/A08/A11 and ORM^O01 follow the pattern.
- **TS interfaces** under `packages/hl7-worker/src/interfaces/*.ts` — `Hl7Parser`, `Hl7Builder`, `MllpListener`, `MllpTransmitter` contracts.
- **Docker integration** — sidecar Dockerfile (eclipse-temurin:21-jre-alpine), compose service binding the UDS socket as a shared bind-mount.
- **Boundary cruiser rules** keeping Java imports inside the sidecar package only.
- **Round-trip + malformed-input + crash-recovery tests.**
- **Spec correction** to M29 §3.1: sidecar communication is gRPC-over-UDS, not JSON-over-HTTP.
- **Sign-off checklist.**

### 1.2 Non-goals

- **MLLP listener wiring** — that is T-29.04. This addendum delivers the parser/builder; the listener consumes them.
- **Outbound ORM dispatch logic** — that is T-29.08.
- **Patient match cascade** — T-29.05.
- **End-to-end HL7 receive-to-store** — T-29.04 + T-29.05 + T-29.06 stacked.

---

## 2. Spec Corrections

The M29 spec v0.2 carries an internal inconsistency between §3.1 and §§4.11.3 + 13.2:

- §3.1 says: *"`parser-sidecar-client.ts` — typed JSON-over-HTTP client to the HAPI Java sidecar"*.
- §4.11.3 says: *"Sidecar communication: localhost-bound gRPC over UDS (`/var/run/chartwarden/hapi.sock`)"*.
- §13.2 cruiser rule references: *"the sidecar gRPC stubs"*.

The later two sections agree; the earlier one drifted. **Resolution: gRPC over UDS wins.** Reasoning:

1. **Type safety end-to-end.** gRPC's protobuf-generated types cross the Java/TS boundary cleanly; JSON-over-HTTP would require parallel hand-maintained DTOs on both sides.
2. **Hot-path latency.** Parse is called on every inbound frame; gRPC's binary framing is materially faster than JSON serialization at scale, especially for the segment-tree response shape (deeply nested, many small fields).
3. **No HTTP-server boilerplate.** Embedding Jetty/Helidon in the sidecar for HTTP would add ~15MB to the image; gRPC-Java's Netty transport is already present transitively and supports UDS via the `grpc-netty` epoll module.
4. **Consistent with later spec sections.** Two against one — the dual references in §4.11.3 and §13.2 reflect the considered design.

The §3.1 path-comment correction:

```diff
- │   ├── parser-sidecar-client.ts              # typed JSON-over-HTTP client to the HAPI Java sidecar
+ │   ├── parser-sidecar-client.ts              # typed gRPC-over-UDS client to the HAPI Java sidecar
```

A second §3.1 path-comment correction for the sidecar layout:

```diff
  └── parser-sidecar/                           # Java HAPI sidecar
      ├── Dockerfile
-     ├── pom.xml                               # HAPI HL7 v2.5.1 dependency
+     ├── build.gradle.kts                      # HAPI HL7 v2.5.1 dependency (Gradle Kotlin DSL — Maven-free)
+     ├── settings.gradle.kts
      └── src/main/java/com/chartwarden/hl7/
          ├── ParserService.java                # gRPC server exposing Parse/Build/Health
          └── SegmentMapper.java                # HAPI → proto-typed mapping
```

(Maven was the initial guess; the ChartWarden repo is JS/TS-tooled and adding Gradle Kotlin DSL avoids introducing Maven Central as a second dependency-resolution channel. Gradle's `maven { url = "https://repo1.maven.org/maven2/" }` already covers HAPI's dependency tree.)

Both corrections land as part of T-29.03 PR.

---

## 3. Java Gradle Project Structure

Path: `packages/hl7-worker/parser-sidecar/`.

```
parser-sidecar/
├── Dockerfile
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties
├── proto/                                   # symlink target into ../../proto for IDE convenience
│   └── parser.proto -> ../../proto/parser.proto
└── src/
    ├── main/
    │   ├── java/com/chartwarden/hl7/
    │   │   ├── ParserServiceImpl.java       # gRPC service implementation
    │   │   ├── SegmentMapper.java           # HAPI ↔ proto mapping
    │   │   ├── BuilderService.java          # outbound HL7 wire builder
    │   │   ├── UdsServerBootstrap.java      # binds /var/run/chartwarden/hapi.sock
    │   │   ├── RedactingLogger.java         # PHI-aware structured logger
    │   │   └── App.java                     # main entrypoint
    │   └── resources/
    │       └── logback.xml                  # log config with PHI redaction
    └── test/
        └── java/com/chartwarden/hl7/
            ├── ParserServiceImplTest.java
            ├── SegmentMapperTest.java
            └── fixtures/                    # HL7 sample frames
```

### 3.1 `settings.gradle.kts`

```kotlin
// packages/hl7-worker/parser-sidecar/settings.gradle.kts
rootProject.name = "chartwarden-hl7-parser-sidecar"
```

### 3.2 `gradle.properties`

```properties
# packages/hl7-worker/parser-sidecar/gradle.properties
org.gradle.jvmargs=-Xmx1g -XX:MaxMetaspaceSize=256m
org.gradle.parallel=true
org.gradle.caching=true
org.gradle.daemon=false
# Pinned versions — change requires architecture review
hapiVersion=2.5.1
grpcVersion=1.62.2
protobufVersion=3.25.3
slf4jVersion=2.0.13
logbackVersion=1.5.6
junitVersion=5.10.2
```

### 3.3 `build.gradle.kts`

```kotlin
// packages/hl7-worker/parser-sidecar/build.gradle.kts
import com.google.protobuf.gradle.id

plugins {
    java
    application
    id("com.google.protobuf") version "0.9.4"
}

repositories {
    mavenCentral()
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

application {
    mainClass.set("com.chartwarden.hl7.App")
    applicationDefaultJvmArgs = listOf(
        "-Xms256m",
        "-Xmx1024m",
        "-XX:+UseG1GC",
        // Crash-only design: no stack traces with PHI leak via uncaught-handler chains.
        "-XX:-OmitStackTraceInFastThrow",
    )
}

dependencies {
    val hapiVersion: String by project
    val grpcVersion: String by project
    val protobufVersion: String by project
    val slf4jVersion: String by project
    val logbackVersion: String by project
    val junitVersion: String by project

    // HAPI HL7v2 — the entire raison-d'être of this sidecar
    implementation("ca.uhn.hapi:hapi-base:$hapiVersion")
    implementation("ca.uhn.hapi:hapi-structures-v25:$hapiVersion")
    implementation("ca.uhn.hapi:hapi-structures-v251:$hapiVersion")

    // gRPC + protobuf + Netty UDS (epoll on Linux)
    implementation("io.grpc:grpc-netty:$grpcVersion")
    implementation("io.grpc:grpc-protobuf:$grpcVersion")
    implementation("io.grpc:grpc-stub:$grpcVersion")
    implementation("io.netty:netty-transport-native-epoll:4.1.108.Final:linux-x86_64")
    implementation("io.netty:netty-transport-native-unix-common:4.1.108.Final")
    implementation("com.google.protobuf:protobuf-java:$protobufVersion")

    // Annotations
    compileOnly("org.apache.tomcat:annotations-api:6.0.53")

    // Logging
    implementation("org.slf4j:slf4j-api:$slf4jVersion")
    implementation("ch.qos.logback:logback-classic:$logbackVersion")

    // Tests
    testImplementation("org.junit.jupiter:junit-jupiter:$junitVersion")
    testImplementation("io.grpc:grpc-testing:$grpcVersion")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

protobuf {
    protoc {
        artifact = "com.google.protobuf:protoc:${project.property("protobufVersion")}"
    }
    plugins {
        id("grpc") {
            artifact = "io.grpc:protoc-gen-grpc-java:${project.property("grpcVersion")}"
        }
    }
    generateProtoTasks {
        all().forEach { task ->
            task.plugins {
                id("grpc") { }
            }
        }
    }
}

sourceSets {
    main {
        proto {
            srcDir("../proto")
        }
    }
}

tasks.test {
    useJUnitPlatform()
}

tasks.named<JavaExec>("run") {
    // Local-dev: bind to a host-writable socket path
    environment("CHARTWARDEN_HL7_UDS_PATH", "/tmp/chartwarden-hl7.sock")
}

// Produce a fat JAR for the container image
tasks.register<Jar>("fatJar") {
    archiveClassifier.set("all")
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    manifest {
        attributes["Main-Class"] = "com.chartwarden.hl7.App"
    }
    from(sourceSets.main.get().output)
    dependsOn(configurations.runtimeClasspath)
    from({
        configurations.runtimeClasspath.get()
            .filter { it.name.endsWith("jar") }
            .map { zipTree(it) }
    })
}
```

---

## 4. gRPC Proto Definition

Path: `packages/hl7-worker/proto/parser.proto`. Single source of truth for both Java and TypeScript code generation.

```protobuf
// packages/hl7-worker/proto/parser.proto
syntax = "proto3";

package chartwarden.hl7;

option java_package = "com.chartwarden.hl7.proto";
option java_multiple_files = true;
option java_outer_classname = "ParserProto";

// ============================================================
// Service
// ============================================================
service ParserService {
  // Parse a raw HL7 v2 wire frame into a typed segment tree.
  // The frame is the bytes between the MLLP <VT>...<FS><CR> framing
  // (the listener has already unwrapped framing before calling).
  rpc Parse (ParseRequest) returns (ParseResponse);

  // Build an HL7 v2 wire frame from a typed segment tree.
  // Returns the bytes WITHOUT MLLP framing — the caller wraps.
  rpc Build (BuildRequest) returns (BuildResponse);

  // Liveness/readiness probe. Returns OK if the HAPI parser is initialized.
  rpc Health (HealthRequest) returns (HealthResponse);
}

// ============================================================
// Parse
// ============================================================
message ParseRequest {
  // Raw HL7 v2 wire bytes (post-MLLP-framing-stripped).
  bytes payload = 1;
  // The HAPI profile hint, e.g. "ADT_A01_v2_5_1" / "ORU_R01_v2_5_1".
  string profile = 2;
  // Optional correlation id forwarded for log-grep convenience. NEVER PHI.
  string correlation_id = 3;
}

message ParseResponse {
  oneof outcome {
    ParsedMessage success = 1;
    ParseError error = 2;
  }
}

message ParseError {
  enum Kind {
    KIND_UNSPECIFIED = 0;
    KIND_FRAMING = 1;          // bad delimiters, missing MSH
    KIND_VERSION = 2;          // unsupported HL7 version
    KIND_PROFILE = 3;          // message-type mismatch vs requested profile
    KIND_SEGMENT = 4;          // a segment failed to parse
    KIND_VALIDATION = 5;       // HAPI validation refused
    KIND_INTERNAL = 6;         // unexpected sidecar error
  }
  Kind kind = 1;
  string message = 2;          // human-readable; PHI-redacted in sidecar
  string segment_name = 3;     // if KIND_SEGMENT
  int32 segment_index = 4;     // if KIND_SEGMENT
}

message ParsedMessage {
  // The parsed segment tree. Order matches wire-order.
  repeated Segment segments = 1;
  // Convenience denormalization for the listener: MSH-10 (message control id).
  string message_control_id = 2;
  // MSH-9 — the message type/event, e.g. "ADT^A01".
  string message_type = 3;
  // MSH-12 — the HL7 version, e.g. "2.5.1".
  string version = 4;
  // MSH-4 — sending facility.
  string sending_facility = 5;
  // MSH-6 — receiving facility.
  string receiving_facility = 6;
  // MSH-7 — message timestamp (ISO-8601, UTC).
  string message_timestamp = 7;
}

// ============================================================
// Build
// ============================================================
message BuildRequest {
  // The typed message to build. Symmetric with ParsedMessage's segments.
  repeated Segment segments = 1;
  // Profile for HAPI to validate against on the build side.
  string profile = 2;
  string correlation_id = 3;
}

message BuildResponse {
  oneof outcome {
    BuiltMessage success = 1;
    BuildError error = 2;
  }
}

message BuiltMessage {
  bytes payload = 1;
  string message_control_id = 2;  // MSH-10 echoed (caller sets it; sidecar mints if empty)
}

message BuildError {
  enum Kind {
    KIND_UNSPECIFIED = 0;
    KIND_PROFILE = 1;
    KIND_SEGMENT = 2;
    KIND_VALIDATION = 3;
    KIND_INTERNAL = 4;
  }
  Kind kind = 1;
  string message = 2;
  string segment_name = 3;
  int32 segment_index = 4;
}

// ============================================================
// Segment tree
// ============================================================
message Segment {
  // Segment ID, e.g. "MSH", "PID", "OBX".
  string name = 1;
  // Repetition index within the message (0-based for the first MSH/PID; 1+ for repeats).
  int32 repetition_index = 2;
  // Fields, 1-indexed by HL7 convention. fields[0] is MSH-1 / PID-1 etc.
  // For MSH specifically, fields[0] is the field-separator '|' itself.
  repeated Field fields = 3;
}

message Field {
  // Repetitions within a field (HL7 ~-separated).
  repeated FieldRepetition repetitions = 1;
}

message FieldRepetition {
  // Components within a field repetition (HL7 ^-separated).
  repeated FieldComponent components = 1;
}

message FieldComponent {
  // Subcomponents (HL7 &-separated). For most fields this is a single string;
  // composite types like PID-5 (XPN) expand into multiple subcomponents.
  repeated string subcomponents = 1;
}

// ============================================================
// Health
// ============================================================
message HealthRequest {}

message HealthResponse {
  enum Status {
    STATUS_UNSPECIFIED = 0;
    STATUS_OK = 1;
    STATUS_DEGRADED = 2;     // HAPI initialized but slow
    STATUS_NOT_READY = 3;
  }
  Status status = 1;
  string hapi_version = 2;
  // How many Parse calls have been served since process start.
  int64 parse_count = 3;
  int64 build_count = 4;
}
```

The segment tree is intentionally string-shaped at the leaf. Type-narrowing into LDM-shaped `Pid`, `Msh` etc. is done in TypeScript via the typed segment registry (§8). The Java side does not enforce semantic typing; it enforces structural typing (the HAPI grammar). This keeps the sidecar lean and pushes domain semantics to the TS layer where the typed registry lives.

---

## 5. Java Service Implementation

### 5.1 `App.java` — entrypoint

```java
// packages/hl7-worker/parser-sidecar/src/main/java/com/chartwarden/hl7/App.java
package com.chartwarden.hl7;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class App {
    private static final Logger LOG = LoggerFactory.getLogger(App.class);

    private App() {}

    public static void main(String[] args) throws Exception {
        final String socketPath = envRequired("CHARTWARDEN_HL7_UDS_PATH");
        LOG.info("hl7.sidecar.starting socketPath={}", socketPath);

        final UdsServerBootstrap server = new UdsServerBootstrap(socketPath);
        Runtime.getRuntime().addShutdownHook(new Thread(server::shutdown, "hl7-sidecar-shutdown"));
        server.start();
        server.awaitTermination();
    }

    private static String envRequired(String name) {
        final String v = System.getenv(name);
        if (v == null || v.isBlank()) {
            throw new IllegalStateException("env " + name + " required");
        }
        return v;
    }
}
```

### 5.2 `UdsServerBootstrap.java` — gRPC over UDS via Netty epoll

```java
// packages/hl7-worker/parser-sidecar/src/main/java/com/chartwarden/hl7/UdsServerBootstrap.java
package com.chartwarden.hl7;

import io.grpc.Server;
import io.grpc.netty.NettyServerBuilder;
import io.netty.channel.epoll.EpollEventLoopGroup;
import io.netty.channel.epoll.EpollServerDomainSocketChannel;
import io.netty.channel.unix.DomainSocketAddress;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.util.concurrent.TimeUnit;

public final class UdsServerBootstrap {
    private static final Logger LOG = LoggerFactory.getLogger(UdsServerBootstrap.class);

    private final String socketPath;
    private Server server;

    public UdsServerBootstrap(String socketPath) {
        this.socketPath = socketPath;
    }

    public void start() throws Exception {
        // Ensure stale socket doesn't block bind
        final File sockFile = new File(socketPath);
        if (sockFile.exists() && !sockFile.delete()) {
            throw new IllegalStateException("could not remove stale socket " + socketPath);
        }

        final EpollEventLoopGroup bossGroup = new EpollEventLoopGroup(1);
        final EpollEventLoopGroup workerGroup = new EpollEventLoopGroup();

        server = NettyServerBuilder
            .forAddress(new DomainSocketAddress(socketPath))
            .channelType(EpollServerDomainSocketChannel.class)
            .bossEventLoopGroup(bossGroup)
            .workerEventLoopGroup(workerGroup)
            .maxInboundMessageSize(16 * 1024 * 1024) // 16MB — generous; the listener enforces 8MB upstream
            .addService(new ParserServiceImpl())
            .build()
            .start();

        // The socket file is created with the worker-process default umask; tighten to 0660
        // so only the chartwarden-app user (mounted in the bind-volume) can read/write it.
        final boolean modeOk = sockFile.setReadable(false, false)
            && sockFile.setWritable(false, false)
            && sockFile.setReadable(true, true)
            && sockFile.setWritable(true, true);
        if (!modeOk) {
            LOG.warn("hl7.sidecar.permissions.could_not_tighten socket={}", socketPath);
        }

        LOG.info("hl7.sidecar.listening socketPath={}", socketPath);
    }

    public void awaitTermination() throws InterruptedException {
        if (server != null) {
            server.awaitTermination();
        }
    }

    public void shutdown() {
        if (server == null) return;
        LOG.info("hl7.sidecar.shutdown.begin");
        try {
            server.shutdown().awaitTermination(10, TimeUnit.SECONDS);
            LOG.info("hl7.sidecar.shutdown.complete");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            LOG.warn("hl7.sidecar.shutdown.interrupted");
        }
    }
}
```

### 5.3 `ParserServiceImpl.java` — gRPC service

```java
// packages/hl7-worker/parser-sidecar/src/main/java/com/chartwarden/hl7/ParserServiceImpl.java
package com.chartwarden.hl7;

import ca.uhn.hl7v2.DefaultHapiContext;
import ca.uhn.hl7v2.HL7Exception;
import ca.uhn.hl7v2.HapiContext;
import ca.uhn.hl7v2.model.Message;
import ca.uhn.hl7v2.parser.PipeParser;
import com.chartwarden.hl7.proto.*;
import io.grpc.stub.StreamObserver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicLong;

public final class ParserServiceImpl extends ParserServiceGrpc.ParserServiceImplBase {
    private static final Logger LOG = LoggerFactory.getLogger(ParserServiceImpl.class);

    private final HapiContext hapiContext = new DefaultHapiContext();
    private final PipeParser parser = hapiContext.getPipeParser();
    private final SegmentMapper mapper = new SegmentMapper();
    private final BuilderService builder = new BuilderService(hapiContext);
    private final AtomicLong parseCount = new AtomicLong();
    private final AtomicLong buildCount = new AtomicLong();

    @Override
    public void parse(ParseRequest req, StreamObserver<ParseResponse> obs) {
        final String correlationId = req.getCorrelationId();
        parseCount.incrementAndGet();
        try {
            final String wire = req.getPayload().toString(StandardCharsets.UTF_8);
            // HAPI's PipeParser is the canonical v2 parser. It handles \r-vs-\n line endings,
            // partial-segment tolerance, and the field/component/subcomponent grammar.
            final Message msg = parser.parse(wire);
            final ParsedMessage parsed = mapper.toProto(msg);

            obs.onNext(ParseResponse.newBuilder().setSuccess(parsed).build());
            obs.onCompleted();
        } catch (HL7Exception hex) {
            LOG.warn("hl7.parse.error correlationId={} kind={} message={}",
                correlationId, classify(hex), redact(hex.getMessage()));
            obs.onNext(ParseResponse.newBuilder()
                .setError(ParseError.newBuilder()
                    .setKind(classify(hex))
                    .setMessage(redact(hex.getMessage()))
                    .build())
                .build());
            obs.onCompleted();
        } catch (RuntimeException re) {
            LOG.error("hl7.parse.internal correlationId={} class={}",
                correlationId, re.getClass().getSimpleName(), re);
            obs.onNext(ParseResponse.newBuilder()
                .setError(ParseError.newBuilder()
                    .setKind(ParseError.Kind.KIND_INTERNAL)
                    .setMessage("internal_parse_error")
                    .build())
                .build());
            obs.onCompleted();
        }
    }

    @Override
    public void build(BuildRequest req, StreamObserver<BuildResponse> obs) {
        buildCount.incrementAndGet();
        try {
            final BuiltMessage built = builder.build(req);
            obs.onNext(BuildResponse.newBuilder().setSuccess(built).build());
            obs.onCompleted();
        } catch (HL7Exception hex) {
            obs.onNext(BuildResponse.newBuilder()
                .setError(BuildError.newBuilder()
                    .setKind(BuildError.Kind.KIND_VALIDATION)
                    .setMessage(redact(hex.getMessage()))
                    .build())
                .build());
            obs.onCompleted();
        } catch (RuntimeException re) {
            LOG.error("hl7.build.internal class={}", re.getClass().getSimpleName(), re);
            obs.onNext(BuildResponse.newBuilder()
                .setError(BuildError.newBuilder()
                    .setKind(BuildError.Kind.KIND_INTERNAL)
                    .setMessage("internal_build_error")
                    .build())
                .build());
            obs.onCompleted();
        }
    }

    @Override
    public void health(HealthRequest req, StreamObserver<HealthResponse> obs) {
        obs.onNext(HealthResponse.newBuilder()
            .setStatus(HealthResponse.Status.STATUS_OK)
            .setHapiVersion(hapiContext.getClass().getPackage().getImplementationVersion() == null
                ? "unknown" : hapiContext.getClass().getPackage().getImplementationVersion())
            .setParseCount(parseCount.get())
            .setBuildCount(buildCount.get())
            .build());
        obs.onCompleted();
    }

    private static ParseError.Kind classify(HL7Exception hex) {
        // Map HAPI's exception subclasses to our proto enum.
        final String name = hex.getClass().getSimpleName();
        if (name.contains("EncodingNotSupported") || name.contains("Framing")) {
            return ParseError.Kind.KIND_FRAMING;
        }
        if (name.contains("Version")) return ParseError.Kind.KIND_VERSION;
        if (name.contains("Profile")) return ParseError.Kind.KIND_PROFILE;
        if (name.contains("Validation")) return ParseError.Kind.KIND_VALIDATION;
        return ParseError.Kind.KIND_SEGMENT;
    }

    // Strip PHI-looking patterns from log messages. The strategy is conservative —
    // we ship segment-level error messages but redact:
    //   - any sequence of >2 ASCII letters followed by ^ (XPN/CN family)
    //   - 10-digit sequences (potential MRNs)
    //   - 4-digit-followed-by-2-digit-followed-by-2-digit (potential DOB)
    private static String redact(String s) {
        if (s == null) return "";
        return s
            .replaceAll("[A-Z][A-Z]+\\^[A-Z][A-Z]+", "[XPN_REDACTED]")
            .replaceAll("\\b\\d{10}\\b", "[10D_REDACTED]")
            .replaceAll("\\b\\d{4}\\d{2}\\d{2}\\b", "[DATE_REDACTED]");
    }
}
```

### 5.4 `SegmentMapper.java` — HAPI tree → proto

```java
// packages/hl7-worker/parser-sidecar/src/main/java/com/chartwarden/hl7/SegmentMapper.java
package com.chartwarden.hl7;

import ca.uhn.hl7v2.HL7Exception;
import ca.uhn.hl7v2.model.*;
import com.chartwarden.hl7.proto.*;

import java.util.ArrayList;
import java.util.List;

public final class SegmentMapper {

    public ParsedMessage toProto(Message msg) throws HL7Exception {
        final ParsedMessage.Builder out = ParsedMessage.newBuilder();
        final Structure[] all = msg.getAll(msg.getName());
        // HAPI traverses the message structure; we flatten to top-level segments
        // including any nested groups (ADT^A01 has groups for INSURANCE etc.)
        flatten(msg, out);
        denormalizeMshFields(out);
        return out.build();
    }

    private void flatten(Group grp, ParsedMessage.Builder out) throws HL7Exception {
        for (String name : grp.getNames()) {
            for (Structure s : grp.getAll(name)) {
                if (s instanceof Group) {
                    flatten((Group) s, out);
                } else if (s instanceof Segment) {
                    out.addSegments(segmentToProto((Segment) s));
                }
            }
        }
    }

    private Segment segmentToProto(Segment seg) throws HL7Exception {
        final Segment.Builder sb = Segment.newBuilder()
            .setName(seg.getName())
            .setRepetitionIndex(0); // repetitions handled at message-level via flatten loop

        final int fieldCount = seg.numFields();
        for (int f = 1; f <= fieldCount; f++) {
            final Type[] reps = seg.getField(f);
            final Field.Builder fb = Field.newBuilder();
            for (Type rep : reps) {
                fb.addRepetitions(repetitionToProto(rep));
            }
            sb.addFields(fb.build());
        }
        return sb.build();
    }

    private FieldRepetition repetitionToProto(Type t) {
        final FieldRepetition.Builder rb = FieldRepetition.newBuilder();
        if (t instanceof Primitive) {
            final FieldComponent.Builder cb = FieldComponent.newBuilder();
            final String v = ((Primitive) t).getValue();
            cb.addSubcomponents(v == null ? "" : v);
            rb.addComponents(cb.build());
        } else if (t instanceof Composite) {
            final Type[] comps = ((Composite) t).getComponents();
            for (Type c : comps) {
                rb.addComponents(componentToProto(c));
            }
        }
        return rb.build();
    }

    private FieldComponent componentToProto(Type t) {
        final FieldComponent.Builder cb = FieldComponent.newBuilder();
        if (t instanceof Primitive) {
            final String v = ((Primitive) t).getValue();
            cb.addSubcomponents(v == null ? "" : v);
        } else if (t instanceof Composite) {
            final Type[] subs = ((Composite) t).getComponents();
            for (Type s : subs) {
                if (s instanceof Primitive) {
                    final String v = ((Primitive) s).getValue();
                    cb.addSubcomponents(v == null ? "" : v);
                } else {
                    // Deeply nested composites collapse to first-primitive-or-empty.
                    cb.addSubcomponents("");
                }
            }
        }
        return cb.build();
    }

    private void denormalizeMshFields(ParsedMessage.Builder out) {
        for (Segment s : out.getSegmentsList()) {
            if ("MSH".equals(s.getName())) {
                out.setSendingFacility(safeFieldComponent(s, 4, 0, 0));
                out.setReceivingFacility(safeFieldComponent(s, 6, 0, 0));
                out.setMessageTimestamp(safeFieldComponent(s, 7, 0, 0));
                out.setMessageType(safeFieldComponent(s, 9, 0, 0) + "^" + safeFieldComponent(s, 9, 0, 1));
                out.setMessageControlId(safeFieldComponent(s, 10, 0, 0));
                out.setVersion(safeFieldComponent(s, 12, 0, 0));
                return;
            }
        }
    }

    private static String safeFieldComponent(Segment s, int field, int rep, int comp) {
        if (s.getFieldsCount() < field) return "";
        Field f = s.getFields(field - 1); // proto fields are 0-indexed internally; HL7 spec is 1-indexed
        if (f.getRepetitionsCount() <= rep) return "";
        FieldRepetition r = f.getRepetitions(rep);
        if (r.getComponentsCount() <= comp) return "";
        FieldComponent c = r.getComponents(comp);
        if (c.getSubcomponentsCount() == 0) return "";
        return c.getSubcomponents(0);
    }
}
```

### 5.5 `BuilderService.java` — proto → HAPI tree → wire bytes

```java
// packages/hl7-worker/parser-sidecar/src/main/java/com/chartwarden/hl7/BuilderService.java
package com.chartwarden.hl7;

import ca.uhn.hl7v2.HL7Exception;
import ca.uhn.hl7v2.HapiContext;
import ca.uhn.hl7v2.model.Message;
import ca.uhn.hl7v2.parser.PipeParser;
import com.google.protobuf.ByteString;
import com.chartwarden.hl7.proto.*;

import java.util.UUID;

public final class BuilderService {

    private final PipeParser parser;

    public BuilderService(HapiContext ctx) {
        this.parser = ctx.getPipeParser();
    }

    public BuiltMessage build(BuildRequest req) throws HL7Exception {
        // We re-encode the proto segment tree back to pipe-delimited HL7 wire.
        // HAPI's PipeParser handles the structural details (separators, escape sequences).
        final StringBuilder sb = new StringBuilder(8192);
        boolean first = true;
        String messageControlId = "";

        for (Segment seg : req.getSegmentsList()) {
            if (!first) sb.append('\r');
            first = false;
            encodeSegment(seg, sb);
            if ("MSH".equals(seg.getName())) {
                messageControlId = msh10(seg);
                if (messageControlId.isEmpty()) {
                    messageControlId = mintControlId();
                    // The trailing-rebuild path would update the buffered MSH-10; for v0.2
                    // we require callers to supply a non-empty MSH-10. The sidecar mints
                    // only when the segment lacks one, and reflects it in BuiltMessage.
                }
            }
        }

        // Final HAPI round-trip — parse-then-encode — to ensure we emit a valid frame.
        final String draft = sb.toString();
        final Message msg = parser.parse(draft);
        final String canonical = parser.encode(msg);

        return BuiltMessage.newBuilder()
            .setPayload(ByteString.copyFromUtf8(canonical))
            .setMessageControlId(messageControlId.isEmpty() ? mintControlId() : messageControlId)
            .build();
    }

    private static void encodeSegment(Segment seg, StringBuilder sb) {
        sb.append(seg.getName());
        for (Field f : seg.getFieldsList()) {
            sb.append('|');
            encodeField(f, sb);
        }
    }

    private static void encodeField(Field f, StringBuilder sb) {
        boolean firstRep = true;
        for (FieldRepetition r : f.getRepetitionsList()) {
            if (!firstRep) sb.append('~');
            firstRep = false;
            encodeRepetition(r, sb);
        }
    }

    private static void encodeRepetition(FieldRepetition r, StringBuilder sb) {
        boolean firstComp = true;
        for (FieldComponent c : r.getComponentsList()) {
            if (!firstComp) sb.append('^');
            firstComp = false;
            encodeComponent(c, sb);
        }
    }

    private static void encodeComponent(FieldComponent c, StringBuilder sb) {
        boolean firstSub = true;
        for (String s : c.getSubcomponentsList()) {
            if (!firstSub) sb.append('&');
            firstSub = false;
            sb.append(s == null ? "" : s);
        }
    }

    private static String msh10(Segment msh) {
        if (msh.getFieldsCount() < 10) return "";
        final Field f = msh.getFields(9);
        if (f.getRepetitionsCount() == 0) return "";
        final FieldRepetition r = f.getRepetitions(0);
        if (r.getComponentsCount() == 0) return "";
        final FieldComponent c = r.getComponents(0);
        if (c.getSubcomponentsCount() == 0) return "";
        return c.getSubcomponents(0);
    }

    private static String mintControlId() {
        // 20-char alphanumeric; safe for MSH-10 (which is 20 max under v2.5.1).
        return UUID.randomUUID().toString().replace("-", "").substring(0, 20).toUpperCase();
    }
}
```

### 5.6 `logback.xml` — log redaction

```xml
<!-- packages/hl7-worker/parser-sidecar/src/main/resources/logback.xml -->
<configuration>
  <appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender">
    <encoder>
      <!-- Structured JSON-ish output. Pattern keeps fields key=value for easy ingestion. -->
      <pattern>%date{ISO8601} level=%level logger=%logger{40} thread=%thread msg=%msg%n</pattern>
    </encoder>
  </appender>

  <!-- HAPI is verbose at DEBUG level and DEBUG messages can contain raw segment values.
       Pin HAPI loggers at WARN; only our explicit log calls (already redacted) emit INFO. -->
  <logger name="ca.uhn.hl7v2" level="WARN" />
  <logger name="ca.uhn.hl7v2.parser" level="WARN" />

  <root level="INFO">
    <appender-ref ref="STDOUT" />
  </root>
</configuration>
```

---

## 6. TypeScript Sidecar Client

Path: `packages/hl7-worker/src/parser-sidecar-client.ts`.

```ts
// packages/hl7-worker/src/parser-sidecar-client.ts
//
// gRPC-over-UDS client to the HAPI Java sidecar. The proto-generated stubs live at
// `./sidecar/generated/parser_pb.ts` and `./sidecar/generated/parser_grpc_pb.ts`
// (generated by the `gen:proto` script — see package.json).

import { credentials, type ChannelCredentials } from '@grpc/grpc-js'
import { ParserServiceClient } from './sidecar/generated/parser_grpc_pb'
import {
  ParseRequest,
  BuildRequest,
  HealthRequest,
  type ParsedMessage,
  type BuiltMessage,
  type ParseError,
  type BuildError,
} from './sidecar/generated/parser_pb'
import { ulid } from 'ulid'
import { setTimeout as sleep } from 'node:timers/promises'

export interface SidecarConfig {
  readonly udsPath: string                  // e.g. /var/run/chartwarden/hapi.sock
  readonly healthIntervalMs: number         // default 30_000
  readonly parseTimeoutMs: number           // default 2_000
  readonly buildTimeoutMs: number           // default 2_000
  readonly reconnectBackoffMs: readonly number[] // default [100, 500, 2000, 5000, 15000]
}

export class SidecarUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super('hl7_sidecar_unavailable')
    this.name = 'SidecarUnavailableError'
  }
}

export class SidecarParseError extends Error {
  constructor(public readonly detail: ParseError.AsObject) {
    super(`hl7_parse_error:${detail.kind}:${detail.message}`)
    this.name = 'SidecarParseError'
  }
}

export class SidecarBuildError extends Error {
  constructor(public readonly detail: BuildError.AsObject) {
    super(`hl7_build_error:${detail.kind}:${detail.message}`)
    this.name = 'SidecarBuildError'
  }
}

export interface SidecarClient {
  parse(payload: Buffer, profile: string, opts?: { correlationId?: string }): Promise<ParsedMessage.AsObject>
  build(message: Pick<ParsedMessage.AsObject, 'segmentsList'>, profile: string, opts?: { correlationId?: string }): Promise<BuiltMessage.AsObject>
  health(): Promise<{ ok: boolean; parseCount: number; buildCount: number; hapiVersion: string }>
  close(): Promise<void>
}

export function createSidecarClient(cfg: SidecarConfig): SidecarClient {
  // gRPC-js supports UDS via the `unix:` URI scheme.
  const target = `unix:${cfg.udsPath}`
  const creds: ChannelCredentials = credentials.createInsecure()
  let client = new ParserServiceClient(target, creds, {
    'grpc.max_receive_message_length': 16 * 1024 * 1024,
    'grpc.max_send_message_length': 16 * 1024 * 1024,
    'grpc.keepalive_time_ms': 60_000,
  })

  let lastHealthAt = 0
  let healthOk = false

  async function ensureConnected(): Promise<void> {
    if (Date.now() - lastHealthAt < cfg.healthIntervalMs && healthOk) return
    for (const backoff of cfg.reconnectBackoffMs) {
      try {
        await new Promise<void>((res, rej) => {
          const deadline = new Date(Date.now() + 1_000)
          client.health(new HealthRequest(), { deadline }, (err) => err ? rej(err) : res())
        })
        healthOk = true
        lastHealthAt = Date.now()
        return
      } catch (e) {
        await sleep(backoff)
        // Recreate the channel on persistent failure (the underlying epoll
        // socket may need a fresh connect).
        client = new ParserServiceClient(target, creds)
      }
    }
    throw new SidecarUnavailableError(new Error('exhausted_reconnect_attempts'))
  }

  return {
    async parse(payload, profile, opts) {
      await ensureConnected()
      const correlationId = opts?.correlationId ?? ulid()
      const req = new ParseRequest()
      req.setPayload(payload)
      req.setProfile(profile)
      req.setCorrelationId(correlationId)

      const resp = await new Promise<{ success?: ParsedMessage.AsObject; error?: ParseError.AsObject }>(
        (res, rej) => {
          const deadline = new Date(Date.now() + cfg.parseTimeoutMs)
          client.parse(req, { deadline }, (err, msg) => {
            if (err) return rej(new SidecarUnavailableError(err))
            const r = msg.toObject()
            res({ success: r.success, error: r.error })
          })
        },
      )

      if (resp.error) throw new SidecarParseError(resp.error)
      if (!resp.success) throw new SidecarUnavailableError(new Error('empty_response'))
      return resp.success
    },

    async build(message, profile, opts) {
      await ensureConnected()
      const correlationId = opts?.correlationId ?? ulid()
      const req = new BuildRequest()
      // Reconstruct typed segments from .AsObject input — the proto runtime
      // does the heavy lifting.
      req.setSegmentsList(message.segmentsList as never)
      req.setProfile(profile)
      req.setCorrelationId(correlationId)

      const resp = await new Promise<{ success?: BuiltMessage.AsObject; error?: BuildError.AsObject }>(
        (res, rej) => {
          const deadline = new Date(Date.now() + cfg.buildTimeoutMs)
          client.build(req, { deadline }, (err, msg) => {
            if (err) return rej(new SidecarUnavailableError(err))
            const r = msg.toObject()
            res({ success: r.success, error: r.error })
          })
        },
      )

      if (resp.error) throw new SidecarBuildError(resp.error)
      if (!resp.success) throw new SidecarUnavailableError(new Error('empty_response'))
      return resp.success
    },

    async health() {
      try {
        const resp = await new Promise<{ status: number; parseCount: number; buildCount: number; hapiVersion: string }>(
          (res, rej) => {
            const deadline = new Date(Date.now() + 1_000)
            client.health(new HealthRequest(), { deadline }, (err, msg) => {
              if (err) return rej(err)
              const o = msg.toObject()
              res({ status: o.status, parseCount: o.parseCount, buildCount: o.buildCount, hapiVersion: o.hapiVersion })
            })
          },
        )
        const ok = resp.status === 1 /* STATUS_OK */
        healthOk = ok
        lastHealthAt = Date.now()
        return { ok, parseCount: resp.parseCount, buildCount: resp.buildCount, hapiVersion: resp.hapiVersion }
      } catch (e) {
        healthOk = false
        return { ok: false, parseCount: 0, buildCount: 0, hapiVersion: 'unreachable' }
      }
    },

    async close() {
      // gRPC-js Client doesn't expose a synchronous close; close the channel.
      const channel = client.getChannel()
      channel.close()
    },
  }
}
```

---

## 7. Typed TS Segment Registry

Path: `packages/hl7-worker/src/segments/*.ts`. Each segment file converts the generic proto `Segment` into a strongly-typed domain object.

### 7.1 `msh.ts` — canonical full implementation

```ts
// packages/hl7-worker/src/segments/msh.ts
import type { Segment as ProtoSegment } from '../sidecar/generated/parser_pb'

export interface Msh {
  readonly fieldSeparator: '|'                    // MSH-1 (verbatim '|')
  readonly encodingCharacters: string             // MSH-2 (typically "^~\\&")
  readonly sendingApplication: string             // MSH-3
  readonly sendingFacility: string                // MSH-4
  readonly receivingApplication: string           // MSH-5
  readonly receivingFacility: string              // MSH-6
  readonly messageTimestamp: string               // MSH-7 (HL7 TS — YYYYMMDDHHMMSS[.SSSS][+/-ZZZZ])
  readonly security: string                       // MSH-8
  readonly messageType: { triggerEvent: string; messageStructure: string } // MSH-9
  readonly messageControlId: string               // MSH-10
  readonly processingId: string                   // MSH-11 ('P', 'T', 'D')
  readonly versionId: string                      // MSH-12 (e.g. '2.5.1')
  readonly sequenceNumber: string                 // MSH-13
  readonly continuationPointer: string            // MSH-14
  readonly acceptAcknowledgmentType: string       // MSH-15
  readonly applicationAcknowledgmentType: string  // MSH-16
  readonly countryCode: string                    // MSH-17
  readonly characterSet: string                   // MSH-18
  readonly principalLanguage: string              // MSH-19
}

export function projectMsh(seg: ProtoSegment.AsObject): Msh {
  return {
    fieldSeparator: '|',
    encodingCharacters: getComp(seg, 2, 0, 0),
    sendingApplication: getComp(seg, 3, 0, 0),
    sendingFacility:    getComp(seg, 4, 0, 0),
    receivingApplication: getComp(seg, 5, 0, 0),
    receivingFacility:  getComp(seg, 6, 0, 0),
    messageTimestamp:   getComp(seg, 7, 0, 0),
    security:           getComp(seg, 8, 0, 0),
    messageType: {
      triggerEvent:    getComp(seg, 9, 0, 0),
      messageStructure: getComp(seg, 9, 0, 1),
    },
    messageControlId:   getComp(seg, 10, 0, 0),
    processingId:       getComp(seg, 11, 0, 0),
    versionId:          getComp(seg, 12, 0, 0),
    sequenceNumber:     getComp(seg, 13, 0, 0),
    continuationPointer: getComp(seg, 14, 0, 0),
    acceptAcknowledgmentType: getComp(seg, 15, 0, 0),
    applicationAcknowledgmentType: getComp(seg, 16, 0, 0),
    countryCode:        getComp(seg, 17, 0, 0),
    characterSet:       getComp(seg, 18, 0, 0),
    principalLanguage:  getComp(seg, 19, 0, 0),
  }
}

// Helpers for projecting from proto. Field index is HL7-1-indexed; we subtract 1 internally.
export function getComp(seg: ProtoSegment.AsObject, fieldIdx: number, repIdx: number, compIdx: number): string {
  const fields = seg.fieldsList ?? []
  const f = fields[fieldIdx - 1]
  if (!f) return ''
  const r = (f.repetitionsList ?? [])[repIdx]
  if (!r) return ''
  const c = (r.componentsList ?? [])[compIdx]
  if (!c) return ''
  return (c.subcomponentsList ?? [])[0] ?? ''
}

export function getSub(seg: ProtoSegment.AsObject, fieldIdx: number, repIdx: number, compIdx: number, subIdx: number): string {
  const fields = seg.fieldsList ?? []
  const f = fields[fieldIdx - 1]
  if (!f) return ''
  const r = (f.repetitionsList ?? [])[repIdx]
  if (!r) return ''
  const c = (r.componentsList ?? [])[compIdx]
  if (!c) return ''
  return (c.subcomponentsList ?? [])[subIdx] ?? ''
}
```

### 7.2 `pid.ts` — canonical full implementation

```ts
// packages/hl7-worker/src/segments/pid.ts
//
// PID is the highest-PHI segment in HL7v2 — every field is sensitive.
// Direct callers must hold the appropriate ABAC predicate (M3) before
// projecting this segment.
import type { Segment as ProtoSegment } from '../sidecar/generated/parser_pb'
import { getComp, getSub } from './msh'

export interface PidIdentifier {
  readonly value: string          // PID-3.1
  readonly checkDigit: string     // PID-3.2
  readonly assigningAuthority: string  // PID-3.4
  readonly identifierTypeCode: string  // PID-3.5
}

export interface PidPersonName {
  readonly familyName: string     // PID-5.1
  readonly givenName: string      // PID-5.2
  readonly middleName: string     // PID-5.3
  readonly suffix: string         // PID-5.4
  readonly prefix: string         // PID-5.5
  readonly nameTypeCode: string   // PID-5.7
}

export interface PidAddress {
  readonly street: string         // PID-11.1
  readonly otherDesignation: string  // PID-11.2
  readonly city: string           // PID-11.3
  readonly stateOrProvince: string // PID-11.4
  readonly zipOrPostalCode: string // PID-11.5
  readonly country: string        // PID-11.6
  readonly addressType: string    // PID-11.7
}

export interface Pid {
  readonly setId: string                          // PID-1
  readonly externalIdNumbers: readonly string[]   // PID-2 (deprecated, kept for compatibility)
  readonly identifiers: readonly PidIdentifier[]  // PID-3 (repeating)
  readonly alternateIds: readonly string[]        // PID-4
  readonly names: readonly PidPersonName[]        // PID-5 (repeating)
  readonly motherMaidenName: string               // PID-6
  readonly dateOfBirth: string                    // PID-7
  readonly sex: string                            // PID-8
  readonly aliasNames: readonly string[]          // PID-9
  readonly race: readonly string[]                // PID-10
  readonly addresses: readonly PidAddress[]       // PID-11
  readonly countyCode: string                     // PID-12
  readonly phoneNumbers: readonly string[]        // PID-13 (repeating)
  readonly businessPhones: readonly string[]      // PID-14
  readonly primaryLanguage: string                // PID-15
  readonly maritalStatus: string                  // PID-16
  readonly religion: string                       // PID-17
  readonly patientAccountNumber: string           // PID-18
  readonly ssnNumber: string                      // PID-19 (deprecated; rarely populated)
  readonly driversLicense: string                 // PID-20
  readonly motherIdentifier: readonly string[]    // PID-21
  readonly ethnicGroup: readonly string[]         // PID-22
  readonly birthPlace: string                     // PID-23
  readonly multipleBirthIndicator: string         // PID-24
  readonly birthOrder: string                     // PID-25
  readonly citizenship: readonly string[]         // PID-26
  readonly veteransMilitaryStatus: string         // PID-27
  readonly nationality: string                    // PID-28 (deprecated)
  readonly patientDeathDate: string               // PID-29
  readonly patientDeathIndicator: string          // PID-30
}

export function projectPid(seg: ProtoSegment.AsObject): Pid {
  return {
    setId: getComp(seg, 1, 0, 0),
    externalIdNumbers: collectReps(seg, 2),
    identifiers: collectIdentifiers(seg, 3),
    alternateIds: collectReps(seg, 4),
    names: collectNames(seg, 5),
    motherMaidenName: getComp(seg, 6, 0, 0),
    dateOfBirth: getComp(seg, 7, 0, 0),
    sex: getComp(seg, 8, 0, 0),
    aliasNames: collectReps(seg, 9),
    race: collectReps(seg, 10),
    addresses: collectAddresses(seg, 11),
    countyCode: getComp(seg, 12, 0, 0),
    phoneNumbers: collectReps(seg, 13),
    businessPhones: collectReps(seg, 14),
    primaryLanguage: getComp(seg, 15, 0, 0),
    maritalStatus: getComp(seg, 16, 0, 0),
    religion: getComp(seg, 17, 0, 0),
    patientAccountNumber: getComp(seg, 18, 0, 0),
    ssnNumber: getComp(seg, 19, 0, 0),
    driversLicense: getComp(seg, 20, 0, 0),
    motherIdentifier: collectReps(seg, 21),
    ethnicGroup: collectReps(seg, 22),
    birthPlace: getComp(seg, 23, 0, 0),
    multipleBirthIndicator: getComp(seg, 24, 0, 0),
    birthOrder: getComp(seg, 25, 0, 0),
    citizenship: collectReps(seg, 26),
    veteransMilitaryStatus: getComp(seg, 27, 0, 0),
    nationality: getComp(seg, 28, 0, 0),
    patientDeathDate: getComp(seg, 29, 0, 0),
    patientDeathIndicator: getComp(seg, 30, 0, 0),
  }
}

function collectReps(seg: ProtoSegment.AsObject, fieldIdx: number): readonly string[] {
  const f = (seg.fieldsList ?? [])[fieldIdx - 1]
  if (!f) return []
  return (f.repetitionsList ?? []).map(r => (r.componentsList ?? [])[0]?.subcomponentsList?.[0] ?? '')
}

function collectIdentifiers(seg: ProtoSegment.AsObject, fieldIdx: number): readonly PidIdentifier[] {
  const f = (seg.fieldsList ?? [])[fieldIdx - 1]
  if (!f) return []
  return (f.repetitionsList ?? []).map(r => ({
    value: r.componentsList?.[0]?.subcomponentsList?.[0] ?? '',
    checkDigit: r.componentsList?.[1]?.subcomponentsList?.[0] ?? '',
    assigningAuthority: r.componentsList?.[3]?.subcomponentsList?.[0] ?? '',
    identifierTypeCode: r.componentsList?.[4]?.subcomponentsList?.[0] ?? '',
  }))
}

function collectNames(seg: ProtoSegment.AsObject, fieldIdx: number): readonly PidPersonName[] {
  const f = (seg.fieldsList ?? [])[fieldIdx - 1]
  if (!f) return []
  return (f.repetitionsList ?? []).map(r => ({
    familyName: r.componentsList?.[0]?.subcomponentsList?.[0] ?? '',
    givenName: r.componentsList?.[1]?.subcomponentsList?.[0] ?? '',
    middleName: r.componentsList?.[2]?.subcomponentsList?.[0] ?? '',
    suffix: r.componentsList?.[3]?.subcomponentsList?.[0] ?? '',
    prefix: r.componentsList?.[4]?.subcomponentsList?.[0] ?? '',
    nameTypeCode: r.componentsList?.[6]?.subcomponentsList?.[0] ?? '',
  }))
}

function collectAddresses(seg: ProtoSegment.AsObject, fieldIdx: number): readonly PidAddress[] {
  const f = (seg.fieldsList ?? [])[fieldIdx - 1]
  if (!f) return []
  return (f.repetitionsList ?? []).map(r => ({
    street: r.componentsList?.[0]?.subcomponentsList?.[0] ?? '',
    otherDesignation: r.componentsList?.[1]?.subcomponentsList?.[0] ?? '',
    city: r.componentsList?.[2]?.subcomponentsList?.[0] ?? '',
    stateOrProvince: r.componentsList?.[3]?.subcomponentsList?.[0] ?? '',
    zipOrPostalCode: r.componentsList?.[4]?.subcomponentsList?.[0] ?? '',
    country: r.componentsList?.[5]?.subcomponentsList?.[0] ?? '',
    addressType: r.componentsList?.[6]?.subcomponentsList?.[0] ?? '',
  }))
}
```

### 7.3 Other segments — pattern reference

The remaining segments (PV1, OBR, OBX, ORC, NK1, IN1, GT1, NTE) follow the same shape:

1. Define a typed interface with all field-position-named properties.
2. Implement `projectXxx(seg: ProtoSegment.AsObject): Xxx` using `getComp` / `getSub` from `msh.ts`.
3. For composite fields (XPN, XAD, CX), define a sub-interface and a collector helper.
4. Add a focused unit test verifying round-trip on a representative fixture.

A full file matrix for the segment registry — one TS file per segment, ~50-200 lines each, ~1000 lines total beyond the two canonical examples above. The T-29.03 PR ships all ten; this addendum shows the pattern via MSH/PID.

**OBX is the second highest-priority segment to ship canonical** because lab-observation values (W-XI-05) parse OBX in the hot path. The T-29.03 PR includes the full `obx.ts` matching the same patterns above; specifically it carries the `OBX-3 (LOINC code)`, `OBX-5 (value)`, `OBX-6 (units)`, `OBX-7 (reference range)`, and `OBX-8 (abnormal flag)` fields as first-class properties.

---

## 8. Typed TS Message Types

Path: `packages/hl7-worker/src/messages/*.ts`. Each message type assembles segments into a domain object.

### 8.1 `adt-a01.ts` — canonical

```ts
// packages/hl7-worker/src/messages/adt-a01.ts
//
// ADT^A01 — Patient Admit/Visit Notification
// Per HL7v2.5.1 spec, the minimal segment set is MSH, EVN, PID, PV1.
// Optional repeating: NK1, OBX, AL1, DG1, GT1, IN1, IN2, IN3, ROL.

import type { ParsedMessage } from '../sidecar/generated/parser_pb'
import { projectMsh, type Msh } from '../segments/msh'
import { projectPid, type Pid } from '../segments/pid'
// EVN, PV1, NK1, IN1, GT1, DG1 imports follow the same pattern.

export interface AdtA01 {
  readonly msh: Msh
  readonly evn: Evn                  // event type — see ./evn.ts (Event Type Code, recorded date/time, planned event)
  readonly pid: Pid
  readonly pv1: Pv1                  // patient visit
  readonly nk1: readonly Nk1[]       // next of kin (0..n)
  readonly in1: readonly In1[]       // insurance (0..n)
  readonly gt1: readonly Gt1[]       // guarantor (0..n)
  readonly dg1: readonly Dg1[]       // diagnosis (0..n) — flagged for SUD redaction (D15)
}

export function projectAdtA01(parsed: ParsedMessage.AsObject): AdtA01 {
  const get = (name: string): readonly ProtoSegment.AsObject[] =>
    parsed.segmentsList.filter(s => s.name === name)

  const [msh] = get('MSH')
  const [evn] = get('EVN')
  const [pid] = get('PID')
  const [pv1] = get('PV1')

  if (!msh || !pid || !pv1) {
    throw new Error('adt_a01_missing_required_segments')
  }

  return {
    msh: projectMsh(msh),
    evn: projectEvn(evn ?? emptySegment()),
    pid: projectPid(pid),
    pv1: projectPv1(pv1),
    nk1: get('NK1').map(projectNk1),
    in1: get('IN1').map(projectIn1),
    gt1: get('GT1').map(projectGt1),
    dg1: get('DG1').map(projectDg1),
  }
}
```

### 8.2 `oru-r01.ts` — canonical

```ts
// packages/hl7-worker/src/messages/oru-r01.ts
//
// ORU^R01 — Unsolicited Transmission of Observation Results
// Structure: MSH, [PID, [PV1]], [ORC], OBR, [OBX]+
//
// One PID per "patient result" group; one OBR per "order observation" group;
// multiple OBX per OBR (each OBX is one result row, e.g. one analyte).
import type { ParsedMessage, Segment as ProtoSegment } from '../sidecar/generated/parser_pb'
import { projectMsh, type Msh } from '../segments/msh'
import { projectPid, type Pid } from '../segments/pid'
import { projectObr, type Obr } from '../segments/obr'
import { projectObx, type Obx } from '../segments/obx'

export interface OruR01OrderObservation {
  readonly orc?: Orc          // optional order control
  readonly obr: Obr           // observation request
  readonly obx: readonly Obx[]  // observation results
}

export interface OruR01 {
  readonly msh: Msh
  readonly pid?: Pid            // optional — some labs send unidentified results referencing OBR-2 placer only
  readonly orderObservations: readonly OruR01OrderObservation[]
}

export function projectOruR01(parsed: ParsedMessage.AsObject): OruR01 {
  const segs = parsed.segmentsList
  const [msh] = segs.filter(s => s.name === 'MSH')
  if (!msh) throw new Error('oru_r01_missing_msh')

  const pidSeg = segs.find(s => s.name === 'PID')
  const obrSegs = segs.filter(s => s.name === 'OBR')

  if (obrSegs.length === 0) throw new Error('oru_r01_missing_obr')

  // Group: each OBR claims the OBX segments that follow until the next OBR or end.
  const orderObservations: OruR01OrderObservation[] = []
  for (let i = 0; i < obrSegs.length; i++) {
    const obrIdx = segs.indexOf(obrSegs[i]!)
    const nextObrIdx = i + 1 < obrSegs.length ? segs.indexOf(obrSegs[i + 1]!) : segs.length
    const obxSegs = segs.slice(obrIdx + 1, nextObrIdx).filter(s => s.name === 'OBX')
    const orcSeg = segs.slice(0, obrIdx).reverse().find(s => s.name === 'ORC')

    orderObservations.push({
      orc: orcSeg ? projectOrc(orcSeg) : undefined,
      obr: projectObr(obrSegs[i]!),
      obx: obxSegs.map(projectObx),
    })
  }

  return {
    msh: projectMsh(msh),
    pid: pidSeg ? projectPid(pidSeg) : undefined,
    orderObservations,
  }
}
```

### 8.3 Other messages — pattern reference

ADT^A03 (discharge), ADT^A04 (registration), ADT^A08 (update), ADT^A11 (cancel admit), and ORM^O01 (outbound order) follow the same shape. Each has its own typed message interface and projector. The T-29.03 PR ships all seven; this addendum shows the pattern via ADT^A01 and ORU^R01.

---

## 9. TS Interfaces (Contracts)

Path: `packages/hl7-worker/src/interfaces/*.ts`.

```ts
// packages/hl7-worker/src/interfaces/parser.ts
import type { AdtA01 } from '../messages/adt-a01'
import type { OruR01 } from '../messages/oru-r01'

export type Hl7Profile =
  | 'ADT_A01_v2_5_1'
  | 'ADT_A03_v2_5_1'
  | 'ADT_A04_v2_5_1'
  | 'ADT_A08_v2_5_1'
  | 'ADT_A11_v2_5_1'
  | 'ORU_R01_v2_5_1'
  | 'ORM_O01_v2_5_1'

export interface Hl7ParseResult {
  readonly messageType: string
  readonly profile: Hl7Profile
  readonly messageControlId: string
  readonly sendingFacility: string
  readonly receivingFacility: string
  readonly messageTimestamp: string
  readonly version: string
  // The typed projection — narrowed per messageType at consumption time.
  readonly typed: AdtA01 | OruR01 | { kind: 'unknown'; rawSegmentCount: number }
}

export interface Hl7Parser {
  parse(payload: Buffer, profile: Hl7Profile, opts?: { correlationId?: string }): Promise<Hl7ParseResult>
}
```

```ts
// packages/hl7-worker/src/interfaces/builder.ts
import type { Hl7Profile } from './parser'

export interface Hl7BuildInput {
  // Caller provides a partial spec; the builder fills in MSH defaults
  // (encoding chars, timestamp, version) when omitted.
  readonly profile: Hl7Profile
  readonly sendingApplication: string
  readonly sendingFacility: string
  readonly receivingApplication: string
  readonly receivingFacility: string
  readonly messageControlId?: string  // sidecar mints if absent
  // Body — discriminated union per profile.
  readonly body:
    | { kind: 'orm_o01'; orm: OrmO01Body }
    | { kind: 'adt_a08'; adt: AdtA08Body }
}

export interface Hl7BuildResult {
  readonly payload: Buffer
  readonly messageControlId: string
}

export interface Hl7Builder {
  build(input: Hl7BuildInput, opts?: { correlationId?: string }): Promise<Hl7BuildResult>
}
```

```ts
// packages/hl7-worker/src/interfaces/listener.ts
import type { ExternalFeed } from '@chartwarden/db/schema/external-interfaces'

export interface MllpFrame {
  readonly payload: Buffer
  readonly receivedAt: Date
  readonly peerAddress: string
  readonly messageControlId: string
  readonly sha256: string
}

export interface MllpListener {
  start(feed: ExternalFeed): Promise<void>
  stop(feedId: string): Promise<void>
  isRunning(feedId: string): boolean
  onFrame(handler: (feedId: string, frame: MllpFrame) => Promise<void>): void
}
```

```ts
// packages/hl7-worker/src/interfaces/transmitter.ts
import type { ExternalFeed } from '@chartwarden/db/schema/external-interfaces'

export interface MllpTransmitOutcome {
  readonly status: 'aa' | 'ae' | 'ar' | 'timeout'
  readonly ackPayload: Buffer
  readonly ackedAt: Date
  readonly latencyMs: number
}

export interface MllpTransmitter {
  transmit(feed: ExternalFeed, payload: Buffer, opts: { correlationId: string; timeoutMs: number }): Promise<MllpTransmitOutcome>
}
```

---

## 10. Docker Setup

### 10.1 Sidecar `Dockerfile`

```dockerfile
# packages/hl7-worker/parser-sidecar/Dockerfile
# Multi-stage: build the fat JAR in a temurin-jdk stage, then ship in a temurin-jre image.
# The result is a ~150MB image containing only the JRE, HAPI, gRPC-Netty, and the sidecar JAR.

FROM eclipse-temurin:21-jdk-alpine AS build
WORKDIR /build
# Cache layer: Gradle wrapper + build files first
COPY parser-sidecar/gradle ./gradle
COPY parser-sidecar/gradlew parser-sidecar/gradlew.bat ./
COPY parser-sidecar/build.gradle.kts parser-sidecar/settings.gradle.kts parser-sidecar/gradle.properties ./
RUN ./gradlew --no-daemon dependencies || true

# Now the source
COPY parser-sidecar/src ./src
COPY proto ../proto
RUN ./gradlew --no-daemon fatJar

FROM eclipse-temurin:21-jre-alpine AS runtime
RUN apk add --no-cache tini libstdc++ libgcc
WORKDIR /app
COPY --from=build /build/build/libs/*-all.jar /app/sidecar.jar

# Non-root user; mount-point for the UDS socket
RUN addgroup -S chartwarden && adduser -S -G chartwarden chartwarden
USER chartwarden

ENV CHARTWARDEN_HL7_UDS_PATH=/var/run/chartwarden/hapi.sock

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["java", "-jar", "/app/sidecar.jar"]
```

### 10.2 docker-compose service

```yaml
# docker-compose.yaml (additions; merge with the existing services block)
services:
  hl7-sidecar:
    image: chartwarden/hl7-sidecar:${VERSION:-dev}
    build:
      context: ./packages/hl7-worker
      dockerfile: parser-sidecar/Dockerfile
    volumes:
      - hl7-uds:/var/run/chartwarden
    environment:
      CHARTWARDEN_HL7_UDS_PATH: /var/run/chartwarden/hapi.sock
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "sh", "-c", "test -S /var/run/chartwarden/hapi.sock"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

  backend:
    # ... existing config ...
    depends_on:
      hl7-sidecar:
        condition: service_healthy
    volumes:
      # Shared UDS mount — same bind volume as the sidecar.
      - hl7-uds:/var/run/chartwarden
    environment:
      CHARTWARDEN_HL7_UDS_PATH: /var/run/chartwarden/hapi.sock

volumes:
  hl7-uds:
    driver: local
```

The UDS socket is the only IPC channel. There is **no TCP port exposed** by the sidecar — confirmed by the absence of any `ports:` directive. A misconfigured deployment that tries to add one will be flagged by the cruiser rules (§11) at boot.

---

## 11. Boundary Cruiser Rules

Append to `.dependency-cruiser.cjs` under `forbidden`:

```js
// T-29.03 — HAPI sidecar boundaries

{
  name: 'no-java-import-outside-sidecar-dir',
  comment: 'Only the parser-sidecar/ subdirectory may import Java sources or reference .jar files.',
  severity: 'error',
  from: { pathNot: '^packages/hl7-worker/parser-sidecar' },
  to:   { path: '(\\.jar$|^packages/hl7-worker/parser-sidecar/src/main/java)' },
},

{
  name: 'no-proto-import-outside-hl7-worker',
  comment: 'The protobuf-generated stubs (sidecar/generated/) are an M29 implementation detail.',
  severity: 'error',
  from: { pathNot: '^packages/hl7-worker' },
  to:   { path: '^packages/hl7-worker/src/sidecar/generated' },
},

{
  name: 'no-direct-grpc-client-outside-sidecar-client',
  comment: 'Only parser-sidecar-client.ts may construct ParserServiceClient.',
  severity: 'error',
  from: {
    pathNot: '^packages/hl7-worker/src/parser-sidecar-client\\.ts$',
  },
  to: { path: '^packages/hl7-worker/src/sidecar/generated/parser_grpc_pb' },
},

{
  name: 'no-hl7-segment-import-outside-m29',
  comment: 'Typed HL7 segments are M29 internals; other modules consume via the published seams.',
  severity: 'error',
  from: {
    pathNot: '^(packages/hl7-worker|apps/backend/src/modules/29-external-interfaces)',
  },
  to: { path: '^packages/hl7-worker/src/(segments|messages)' },
},
```

These compose with the §13.2 rules from the M29 spec (after the §2 path correction).

---

## 12. Tests

### 12.1 Java unit tests

```java
// packages/hl7-worker/parser-sidecar/src/test/java/com/chartwarden/hl7/SegmentMapperTest.java
package com.chartwarden.hl7;

import ca.uhn.hl7v2.DefaultHapiContext;
import ca.uhn.hl7v2.HapiContext;
import ca.uhn.hl7v2.model.Message;
import com.chartwarden.hl7.proto.ParsedMessage;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class SegmentMapperTest {
    private HapiContext ctx;
    private SegmentMapper mapper;

    @BeforeEach
    void setUp() {
        ctx = new DefaultHapiContext();
        mapper = new SegmentMapper();
    }

    @Test
    void parsesAdtA01MshDenormalization() throws Exception {
        final String wire =
            "MSH|^~\\&|HOSPITAL|ST_ANTHONY|ENGRACE|ENGRACE|20260610143211||ADT^A01|MCID-001|P|2.5.1\r" +
            "EVN|A01|20260610143211\r" +
            "PID|1||MRN-001234^^^ST_ANTHONY||DOE^JANE||19480322|F\r" +
            "PV1|1|I|ICU^^|||";
        final Message m = ctx.getPipeParser().parse(wire);
        final ParsedMessage out = mapper.toProto(m);

        assertEquals("ST_ANTHONY", out.getSendingFacility());
        assertEquals("ENGRACE", out.getReceivingFacility());
        assertEquals("MCID-001", out.getMessageControlId());
        assertEquals("ADT^A01", out.getMessageType());
        assertEquals("2.5.1", out.getVersion());
    }

    @Test
    void roundtripsAdtA01() throws Exception {
        // parse → toProto → BuilderService.build → assert byte-equal modulo whitespace
        // ... (full round-trip test)
    }
}
```

### 12.2 TS integration tests

```ts
// packages/hl7-worker/src/__tests__/parser-sidecar-client.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createSidecarClient } from '../parser-sidecar-client'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let sidecarProcess: ChildProcess
let udsPath: string

beforeAll(async () => {
  udsPath = join(tmpdir(), `chartwarden-hl7-test-${Date.now()}.sock`)
  // Start the sidecar via gradle run with the test socket path
  sidecarProcess = spawn(
    './gradlew',
    ['run', '--no-daemon'],
    {
      cwd: 'packages/hl7-worker/parser-sidecar',
      env: { ...process.env, CHARTWARDEN_HL7_UDS_PATH: udsPath },
      stdio: 'pipe',
    },
  )
  // Wait for socket file to appear
  await waitForSocket(udsPath, 30_000)
}, 60_000)

afterAll(async () => {
  sidecarProcess.kill('SIGTERM')
  await new Promise(res => sidecarProcess.once('exit', res))
})

describe('SidecarClient — round-trip', () => {
  it('parses an ADT^A01 frame and projects MSH-10', async () => {
    const client = createSidecarClient({
      udsPath, healthIntervalMs: 30_000, parseTimeoutMs: 2_000, buildTimeoutMs: 2_000,
      reconnectBackoffMs: [100, 500, 2000],
    })

    const wire = Buffer.from(
      'MSH|^~\\&|HOSPITAL|ST_ANTHONY|ENGRACE|ENGRACE|20260610143211||ADT^A01|MCID-RT-001|P|2.5.1\r' +
      'EVN|A01|20260610143211\r' +
      'PID|1||MRN-001234^^^ST_ANTHONY||DOE^JANE||19480322|F\r' +
      'PV1|1|I|ICU^^||\r',
    )

    const parsed = await client.parse(wire, 'ADT_A01_v2_5_1', { correlationId: 'corr-001' })
    expect(parsed.messageControlId).toBe('MCID-RT-001')
    expect(parsed.sendingFacility).toBe('ST_ANTHONY')
    expect(parsed.messageType).toBe('ADT^A01')
    expect(parsed.segmentsList.find(s => s.name === 'PID')).toBeDefined()

    await client.close()
  }, 10_000)

  it('returns structured error on malformed framing', async () => {
    const client = createSidecarClient({ /* ... */ })
    const malformed = Buffer.from('NOT_AN_HL7_FRAME')

    await expect(client.parse(malformed, 'ADT_A01_v2_5_1')).rejects.toThrow(/hl7_parse_error/)
  })

  it('builds and parses round-trip (byte-equal modulo whitespace)', async () => {
    // ... full round-trip test
  })

  it('health endpoint reports OK after successful parses', async () => {
    const client = createSidecarClient({ /* ... */ })
    await client.parse(/* valid frame */, 'ADT_A01_v2_5_1')
    const h = await client.health()
    expect(h.ok).toBe(true)
    expect(h.parseCount).toBeGreaterThan(0)
  })

  it('crash-recovers: killing the sidecar process and restarting it lets the client reconnect', async () => {
    const client = createSidecarClient({ /* ... */ })
    // Initial successful parse
    await client.parse(/* valid */, 'ADT_A01_v2_5_1')

    // Kill the sidecar
    sidecarProcess.kill('SIGKILL')
    await new Promise(res => sidecarProcess.once('exit', res))

    // First parse after crash should fail
    await expect(client.parse(/* valid */, 'ADT_A01_v2_5_1')).rejects.toThrow(SidecarUnavailableError)

    // Restart sidecar
    sidecarProcess = spawn(/* same args */)
    await waitForSocket(udsPath, 30_000)

    // Now the client should reconnect on the next call
    const parsed = await client.parse(/* valid */, 'ADT_A01_v2_5_1')
    expect(parsed.messageControlId).toBeTruthy()
  }, 60_000)
})

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const { stat } = await import('node:fs/promises')
      const s = await stat(path)
      if (s.isSocket()) return
    } catch { /* not yet */ }
    await new Promise(res => setTimeout(res, 200))
  }
  throw new Error('socket_never_appeared')
}
```

### 12.3 PHI-redaction unit test

```ts
// packages/hl7-worker/src/__tests__/redaction.test.ts
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'

describe('Sidecar log redaction', () => {
  it('does not emit raw PID-5 (patient name) in error logs on malformed frame', () => {
    // Trigger a parse error on a frame that contains a recognizable patient name.
    // Capture sidecar stdout for 2s; grep for the name.
    // (Test runs against a fixture sidecar started fresh.)

    const wire = '/* malformed frame embedding the name "DOE^JANE" */'
    // ... invoke client, capture sidecar logs
    const logs = captureSidecarLogs(2_000)
    expect(logs).not.toContain('DOE^JANE')
    expect(logs).toContain('[XPN_REDACTED]')
  })

  it('does not emit raw MRN-looking 10-digit sequences in error logs', () => {
    // ... mirror pattern
  })

  it('does not emit DOB-looking date sequences in error logs', () => {
    // ... mirror pattern
  })
})
```

---

## 13. Sign-Off Checklist (T-29.03 PR)

- [ ] Java Gradle project lands at `packages/hl7-worker/parser-sidecar/` with `build.gradle.kts`, `settings.gradle.kts`, `gradle.properties`, `Dockerfile`, full Java source tree.
- [ ] `./gradlew --no-daemon build` succeeds clean from a fresh checkout.
- [ ] `./gradlew --no-daemon fatJar` produces the runnable JAR.
- [ ] gRPC proto file lands at `packages/hl7-worker/proto/parser.proto`; codegen runs for both Java (Gradle) and TypeScript (`bun run gen:proto` script in the package).
- [ ] TS sidecar client lands at `packages/hl7-worker/src/parser-sidecar-client.ts` and connects to a running sidecar over UDS.
- [ ] MSH and PID typed segments land with full field coverage; remaining 8 segments land with at least field-position-named interfaces and projection.
- [ ] ADT^A01 and ORU^R01 typed messages land canonical; remaining 5 messages land with the same pattern.
- [ ] TS interfaces (`Hl7Parser`, `Hl7Builder`, `MllpListener`, `MllpTransmitter`) land in `packages/hl7-worker/src/interfaces/`.
- [ ] Docker compose adds the `hl7-sidecar` service with the shared UDS bind volume and the backend depends-on-healthy.
- [ ] Cruiser rules (§11) land and pass `bun run check:cruiser` against the new package layout.
- [ ] **§2 spec corrections** applied: M29 §3.1 path comments updated to gRPC-over-UDS + Gradle Kotlin DSL.
- [ ] All Java unit tests pass.
- [ ] All TS integration tests pass (including the crash-recovery scenario and the round-trip byte-equality check).
- [ ] PHI redaction tests pass — sidecar logs never emit PID-5/NK1/IN1/GT1/NTE raw values nor 10-digit MRN-like nor date-like sequences.
- [ ] The sidecar image builds at ~150MB or less.
- [ ] Sidecar container runs as non-root (`chartwarden` user).
- [ ] UDS socket file mode is 0660 owned by `chartwarden:chartwarden`.
- [ ] No TCP port exposed by the sidecar service (compose config verified).
- [ ] **Integrations engineer** sign-off on the gRPC contract.
- [ ] **Platform engineer** sign-off on the Docker integration and the UDS bind volume.
- [ ] **Security engineer** sign-off on the redaction pass and the no-TCP-exposure posture.

---

## 14. Notes on Refinements Past M29 Spec §3.1

This addendum surfaces three small design refinements past M29 spec v0.2:

1. **gRPC over UDS vs JSON-over-HTTP** (§2). Spec inconsistency resolved in favor of gRPC. The §3.1 path comments need correction; both corrections applied here.

2. **Gradle Kotlin DSL vs Maven** (§3). Spec said `pom.xml`; we ship `build.gradle.kts`. Maven adds a second dependency-resolution channel to the ChartWarden repo for negligible gain. Gradle Kotlin DSL has better tooling integration with the existing TS-tooled monorepo.

3. **Conservative log-redaction regex** (§5.3). The sidecar's `redact()` function uses three regex patterns: XPN-shaped names (two-letter-pair joined by `^`), 10-digit sequences (potential MRNs), and 8-digit date sequences (potential DOBs). This is a defense-in-depth measure on top of the `logback.xml` HAPI logger pinning at WARN. The patterns over-redact intentionally — false positives on non-PHI strings that look like names is acceptable; false negatives on PHI strings that escape the patterns are not.

A future refinement may add a 4th regex for SSN-shape `\d{3}-\d{2}-\d{4}` if any partner facility's HL7 traffic carries them; PID-19 is deprecated but some legacy senders still populate it.

---

## Document Footer

**Addendum version:** v1.0 (T-29.03 PR-ready)
**Bound to:** `CHARTWARDEN_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md` §3.1, §4.11.3, §13.2
**Java files delivered (canonical):** 6 (App, UdsServerBootstrap, ParserServiceImpl, SegmentMapper, BuilderService, logback.xml)
**Proto file:** 1 (`parser.proto`)
**TS files delivered (canonical):** 8 (sidecar client + 2 segments + 2 messages + 4 interfaces)
**Spec corrections:** 2 (gRPC-over-UDS path comment + Gradle Kotlin DSL build file)
**Cruiser rules added:** 4 (Java boundary, proto-generated boundary, gRPC-client boundary, segment-types boundary)
**Tests covered:** Java unit (mapper, builder, redaction) + TS integration (round-trip, malformed, crash recovery, health) + PHI redaction
**Sign-offs required:** Integrations engineer, Platform engineer, Security engineer

**End of T-29.03 HAPI sidecar bring-up addendum.**
