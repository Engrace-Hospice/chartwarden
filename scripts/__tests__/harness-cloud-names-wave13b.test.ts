/**
 * Wave 13 part B, B12, L1, C4 (round 10): named subcommands of hosted-service CLIs that open a session or print a credential and passed: `az container exec`,
 * `gcloud app instances ssh`, `doctl apps console`, `fly mpg connect`, `aws ec2-instance-connect ssh` (C4), and the credential printers
 * `gcloud auth print-access-token`, `aws sts get-session-token`, `aws configure export-credentials` (L1). gcloud is installed here but its help did not
 * print these names offline, aws, az, doctl and fly are not installed: every entry is from the tool's documentation and UNVERIFIED against a binary.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;

describe("named session and credential subcommands ask", () => {
  it.each([
    "az container exec -n x -g y",
    "az container attach -n x -g y",
    "gcloud app instances ssh i",
    "gcloud beta app instances scp i:f ./f",
    "doctl apps console x",
    "fly mpg connect",
    "flyctl mpg proxy",
    "aws ec2-instance-connect ssh --instance-id i-1",
    "gcloud auth print-access-token",
    "gcloud auth print-identity-token",
    "gcloud auth application-default print-access-token",
    "aws sts get-session-token",
    "aws sts get-federation-token --name x",
    "aws configure export-credentials",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "az account show",
    "az container list -g y",
    "gcloud app instances list",
    "gcloud auth list",
    "gcloud config list",
    "doctl apps list",
    "fly status",
    "aws sts get-caller-identity",
    "aws configure list",
    "aws s3 ls",
    "aws ec2-instance-connect help",
  ])("%s stays allowed", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});
