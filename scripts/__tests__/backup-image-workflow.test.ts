import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(join(ROOT, ".github/workflows/backup-image.yml"), "utf8");

describe("backup image supply chain (#992/#993)", () => {
  it("pins every third-party action to an immutable commit with a release comment", () => {
    const uses = [...workflow.matchAll(/^\s*-\s+uses:\s+([^@\s]+)@([^\s#]+)\s+#\s+(v\S+)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, action, ref, version] of uses) {
      expect(action).not.toMatch(/^\.\//);
      expect(ref, `${action}@${ref}`).toMatch(/^[0-9a-f]{40}$/);
      expect(version).toMatch(/^v\d/);
    }
    expect(workflow.match(/^\s*-\s+uses:/gm)).toHaveLength(uses.length);
  });

  it("has only scheduled and manual triggers, with no deploy or release path", () => {
    expect(workflow).toMatch(/\n {2}schedule:\n/);
    expect(workflow).toMatch(/\n {2}workflow_dispatch: \{\}\n/);
    expect(workflow).not.toMatch(/\n {2}(push|pull_request|workflow_run):/);
    expect(workflow).not.toMatch(/\b(deploy|release):\n/);
  });

  it("runs one read-only weekly job and no matrix", () => {
    const scheduled = workflow.slice(
      workflow.indexOf("  scheduled-scan:"),
      workflow.indexOf("  publish:"),
    );
    expect(scheduled).toContain("github.event_name == 'schedule'");
    expect(scheduled).toContain("contents: read");
    expect(scheduled).toContain("packages: read");
    expect(scheduled).toContain(
      "uses: docker/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550 # v4.8.0",
    );
    expect(scheduled).toContain("username: ${{ github.actor }}");
    expect(scheduled).toContain("password: ${{ secrets.GITHUB_TOKEN }}");
    expect(scheduled).not.toMatch(/packages: write|id-token: write|matrix:/);
    expect(scheduled).toContain("Scan scheduled image (HIGH/CRITICAL fail)");
    expect(scheduled).toContain("if: ${{ always() }}");
    expect(scheduled).toContain('docker image rm -f "${LOCAL_IMAGE}"');
  });

  it("publishes only a manual main run after its local scan, then signs, attests and verifies", () => {
    const publish = workflow.slice(workflow.indexOf("  publish:"));
    expect(publish).toContain("github.event_name == 'workflow_dispatch'");
    expect(publish).toContain("github.ref == 'refs/heads/main'");
    expect(publish).toContain("packages: write");
    expect(publish).toContain("id-token: write");
    expect(publish).toContain("Build publish image locally (not pushed)");
    expect(publish).toContain("load: true");
    expect(publish).toContain("push: false");
    expect(publish).toContain("image-ref: ${{ env.PUBLISH_IMAGE }}");
    expect(publish).toContain('docker push "$TAGGED_IMAGE"');
    expect(publish.indexOf("Scan local publish image")).toBeLessThan(
      publish.indexOf("Push scanned image"),
    );
    expect(publish).not.toContain("push: true");
    expect(publish).toContain("cosign sign");
    expect(publish).toContain("cosign attest");
    expect(publish).toContain("cosign verify-attestation");
    expect(publish).toContain("CHARTWARDEN_BACKUP_IMAGE=");
    expect(publish).toContain("Remove publish image and SBOM from the persistent runner");
  });
});
