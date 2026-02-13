#!/usr/bin/env bash
set -euo pipefail

# Synv2 AWS Setup — Provisions VPC, SG, IAM, EC2 instance with Docker + control plane
# Outputs SYNV2_HOST, SYNV2_TOKEN, INSTANCE_ID, ELASTIC_IP for CLI config

REGION="${SYNV2_REGION:-us-east-1}"
INSTANCE_TYPE="${SYNV2_INSTANCE_TYPE:-t3.medium}"
DOMAIN="${SYNV2_DOMAIN:-}"
KEY_NAME="${SYNV2_KEY_NAME:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[synv2]${NC} $*"; }
ok()    { echo -e "${GREEN}[synv2]${NC} $*"; }
fail()  { echo -e "${RED}[synv2]${NC} $*" >&2; exit 1; }

# ── Check prerequisites ───────────────────────────────────────
command -v aws >/dev/null 2>&1 || fail "AWS CLI not found. Install: https://aws.amazon.com/cli/"
aws sts get-caller-identity >/dev/null 2>&1 || fail "AWS CLI not configured. Run 'aws configure' first."

info "Region: ${REGION}"
info "Instance type: ${INSTANCE_TYPE}"

# ── Tag prefix for resource tracking ─────────────────────────
SUFFIX=$(openssl rand -hex 4)
TAG_NAME="synv2-${SUFFIX}"

# ── Generate admin API token ─────────────────────────────────
ADMIN_TOKEN=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)

# ── VPC: use default VPC ─────────────────────────────────────
info "Looking up default VPC..."
VPC_ID=$(aws ec2 describe-vpcs \
  --region "$REGION" \
  --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' \
  --output text)

if [ "$VPC_ID" = "None" ] || [ -z "$VPC_ID" ]; then
  fail "No default VPC found in ${REGION}. Create one with: aws ec2 create-default-vpc --region ${REGION}"
fi

SUBNET_ID=$(aws ec2 describe-subnets \
  --region "$REGION" \
  --filters Name=vpc-id,Values="$VPC_ID" Name=default-for-az,Values=true \
  --query 'Subnets[0].SubnetId' \
  --output text)

info "VPC: ${VPC_ID}, Subnet: ${SUBNET_ID}"

# ── Security Group ────────────────────────────────────────────
info "Creating security group..."
SG_ID=$(aws ec2 create-security-group \
  --region "$REGION" \
  --group-name "${TAG_NAME}-sg" \
  --description "Synv2 control plane" \
  --vpc-id "$VPC_ID" \
  --query 'GroupId' \
  --output text)

# Allow SSH (22), HTTP (80), HTTPS (443)
aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
  --ip-permissions \
  IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges='[{CidrIp=0.0.0.0/0,Description=SSH}]' \
  IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges='[{CidrIp=0.0.0.0/0,Description=HTTP}]' \
  IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges='[{CidrIp=0.0.0.0/0,Description=HTTPS}]' \
  >/dev/null

ok "Security group: ${SG_ID}"

# ── IAM Role ─────────────────────────────────────────────────
info "Creating IAM role..."
ROLE_NAME="${TAG_NAME}-role"
INSTANCE_PROFILE="${TAG_NAME}-profile"

aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }' \
  --tags Key=synv2,Value="$TAG_NAME" \
  >/dev/null 2>&1

# Attach managed policies for AWS service access
for POLICY in \
  arn:aws:iam::aws:policy/AmazonS3FullAccess \
  arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess \
  arn:aws:iam::aws:policy/AWSLambda_FullAccess \
  arn:aws:iam::aws:policy/AmazonSQSFullAccess \
  arn:aws:iam::aws:policy/CloudWatchFullAccess; do
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY" 2>/dev/null || true
done

aws iam create-instance-profile \
  --instance-profile-name "$INSTANCE_PROFILE" \
  >/dev/null 2>&1

aws iam add-role-to-instance-profile \
  --instance-profile-name "$INSTANCE_PROFILE" \
  --role-name "$ROLE_NAME" \
  >/dev/null 2>&1

# IAM propagation delay
sleep 10

ok "IAM role: ${ROLE_NAME}"

# ── Find latest Amazon Linux 2023 AMI ────────────────────────
AMI_ID=$(aws ec2 describe-images \
  --region "$REGION" \
  --owners amazon \
  --filters \
    Name=name,Values='al2023-ami-2023.*-x86_64' \
    Name=state,Values=available \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
  --output text)

info "AMI: ${AMI_ID}"

# ── Prepare user-data script ─────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
USER_DATA=$(cat "${SCRIPT_DIR}/user-data.sh" | \
  sed "s|__ADMIN_TOKEN__|${ADMIN_TOKEN}|g" | \
  sed "s|__ENCRYPTION_KEY__|${ENCRYPTION_KEY}|g" | \
  sed "s|__DOMAIN__|${DOMAIN}|g")

# ── Launch EC2 instance ──────────────────────────────────────
info "Launching EC2 instance..."

LAUNCH_ARGS=(
  --region "$REGION"
  --image-id "$AMI_ID"
  --instance-type "$INSTANCE_TYPE"
  --subnet-id "$SUBNET_ID"
  --security-group-ids "$SG_ID"
  --iam-instance-profile "Name=$INSTANCE_PROFILE"
  --user-data "$USER_DATA"
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":50,"VolumeType":"gp3"}}]'
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${TAG_NAME}},{Key=synv2,Value=${TAG_NAME}}]"
  --query 'Instances[0].InstanceId'
  --output text
)

if [ -n "$KEY_NAME" ]; then
  LAUNCH_ARGS+=(--key-name "$KEY_NAME")
fi

INSTANCE_ID=$(aws ec2 run-instances "${LAUNCH_ARGS[@]}")

ok "Instance: ${INSTANCE_ID}"

# ── Allocate Elastic IP ──────────────────────────────────────
info "Allocating Elastic IP..."
ALLOC_ID=$(aws ec2 allocate-address \
  --region "$REGION" \
  --domain vpc \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=${TAG_NAME}},{Key=synv2,Value=${TAG_NAME}}]" \
  --query 'AllocationId' \
  --output text)

# Wait for instance to be running
info "Waiting for instance to start..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

aws ec2 associate-address \
  --region "$REGION" \
  --instance-id "$INSTANCE_ID" \
  --allocation-id "$ALLOC_ID" \
  >/dev/null

ELASTIC_IP=$(aws ec2 describe-addresses \
  --region "$REGION" \
  --allocation-ids "$ALLOC_ID" \
  --query 'Addresses[0].PublicIp' \
  --output text)

ok "Elastic IP: ${ELASTIC_IP}"

# ── Determine host URL ───────────────────────────────────────
if [ -n "$DOMAIN" ]; then
  HOST="https://${DOMAIN}"
  echo ""
  info "Point your DNS A record for ${DOMAIN} → ${ELASTIC_IP}"
  info "Caddy will auto-provision TLS once DNS propagates."
else
  HOST="https://${ELASTIC_IP}"
fi

# ── Save tag name for teardown ───────────────────────────────
echo "$TAG_NAME" > "${SCRIPT_DIR}/.synv2-tag"

# ── Output for CLI config parsing ────────────────────────────
echo ""
echo "SYNV2_HOST=${HOST}"
echo "SYNV2_TOKEN=${ADMIN_TOKEN}"
echo "INSTANCE_ID=${INSTANCE_ID}"
echo "ELASTIC_IP=${ELASTIC_IP}"
echo "TAG_NAME=${TAG_NAME}"

echo ""
ok "Setup complete. Control plane will be ready in ~3 minutes."
ok "Host: ${HOST}"
