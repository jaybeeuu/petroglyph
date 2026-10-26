# Read the live onedrive client id so Lambda env vars can be baked at plan time even
# when terraform runs with -refresh=false. The underlying parameter is updated
# manually (ignore_changes on the resource), so referencing the resource's stale
# state value would bake PLACEHOLDER into env vars.
data "aws_ssm_parameter" "onedrive_client_id" {
  name = aws_ssm_parameter.onedrive_client_id.name
}

resource "aws_ssm_parameter" "github_client_id" {
  name  = "${local.ssm_parameter_prefix}/github/client-id"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "github_client_secret" {
  name  = "${local.ssm_parameter_prefix}/github/client-secret"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "jwt_private_key" {
  name  = "${local.ssm_parameter_prefix}/jwt/private-key"
  type  = "SecureString"
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "jwt_public_key" {
  name  = "${local.ssm_parameter_prefix}/jwt/public-key"
  type  = "SecureString"
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "onedrive_client_id" {
  name  = "${local.ssm_parameter_prefix}/onedrive/client-id"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "onedrive_client_secret" {
  name  = "${local.ssm_parameter_prefix}/onedrive/client-secret"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}
