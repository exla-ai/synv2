#!/usr/bin/env bash
set -euo pipefail

# Synapse AWS Teardown — Destroys all resources created by setup.sh

REGION="${SYNAPSE_REGION:-us-east-1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[synapse]${NC} $*"; }
ok()    { echo -e "${GREEN}[synapse]${NC} $*"; }
fail()  { echo -e "${RED}[synapse]${NC} $*" >&2; exit 1; }

# Read tag name
if [ -f "${SCRIPT_DIR}/.synapse-tag" ]; then
  TAG_NAME=$(cat "${SCRIPT_DIR}/.synapse-tag")
else
  TAG_NAME="${1:-}"
fi

if [ -z "$TAG_NAME" ]; then
  fail "No tag name found. Pass it as argument: ./teardown.sh synapse-XXXX"
fi

info "Tearing down: ${TAG_NAME}"

# ── Terminate EC2 instances ───────────────────────────────────
info "Finding instances..."
INSTANCE_IDS=$(aws ec2 describe-instances \
  --region "$REGION" \
  --filters "Name=tag:synapse,Values=${TAG_NAME}" "Name=instance-state-name,Values=running,stopped,pending" \
  --query 'Reservations[].Instances[].InstanceId' \
  --output text)

if [ -n "$INSTANCE_IDS" ]; then
  info "Terminating: ${INSTANCE_IDS}"
  aws ec2 terminate-instances --region "$REGION" --instance-ids $INSTANCE_IDS >/dev/null
  aws ec2 wait instance-terminated --region "$REGION" --instance-ids $INSTANCE_IDS
  ok "Instances terminated"
else
  info "No instances found"
fi

# ── Release Elastic IPs ──────────────────────────────────────
info "Releasing Elastic IPs..."
ALLOC_IDS=$(aws ec2 describe-addresses \
  --region "$REGION" \
  --filters "Name=tag:synapse,Values=${TAG_NAME}" \
  --query 'Addresses[].AllocationId' \
  --output text)

for AID in $ALLOC_IDS; do
  aws ec2 release-address --region "$REGION" --allocation-id "$AID" 2>/dev/null || true
  ok "Released: ${AID}"
done

# ── Delete security group ────────────────────────────────────
info "Deleting security group..."
SG_ID=$(aws ec2 describe-security-groups \
  --region "$REGION" \
  --filters "Name=group-name,Values=${TAG_NAME}-sg" \
  --query 'SecurityGroups[0].GroupId' \
  --output text 2>/dev/null)

if [ -n "$SG_ID" ] && [ "$SG_ID" != "None" ]; then
  # Retry — SG can take a moment after instance termination
  for i in $(seq 1 5); do
    aws ec2 delete-security-group --region "$REGION" --group-id "$SG_ID" 2>/dev/null && break
    sleep 5
  done
  ok "Security group deleted"
fi

# ── Delete IAM role + instance profile ────────────────────────
ROLE_NAME="${TAG_NAME}-role"
PROFILE_NAME="${TAG_NAME}-profile"

info "Cleaning up IAM..."

# Detach policies
POLICIES=$(aws iam list-attached-role-policies --role-name "$ROLE_NAME" \
  --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null || true)

for POLICY in $POLICIES; do
  aws iam detach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY" 2>/dev/null || true
done

# Remove role from instance profile
aws iam remove-role-from-instance-profile \
  --instance-profile-name "$PROFILE_NAME" \
  --role-name "$ROLE_NAME" 2>/dev/null || true

# Delete instance profile
aws iam delete-instance-profile \
  --instance-profile-name "$PROFILE_NAME" 2>/dev/null || true

# Delete role
aws iam delete-role --role-name "$ROLE_NAME" 2>/dev/null || true

ok "IAM cleaned up"

# Clean up tag file
rm -f "${SCRIPT_DIR}/.synapse-tag"

echo ""
ok "Teardown complete: ${TAG_NAME}"
