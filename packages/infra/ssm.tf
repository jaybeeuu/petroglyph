resource "aws_ssm_parameter" "github_client_id" {
  name  = "/petroglyph/github/client-id"
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
  name  = "/petroglyph/github/client-secret"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "jwt_signing_secret" {
  name  = "/petroglyph/jwt/signing-secret"
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
  name  = "/petroglyph/jwt/private-key"
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
  name  = "/petroglyph/jwt/public-key"
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
  name  = "/petroglyph/onedrive/client-id"
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
  name  = "/petroglyph/onedrive/client-secret"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "onedrive_access_token" {
  name  = "/petroglyph/onedrive/access-token"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "onedrive_refresh_token" {
  name  = "/petroglyph/onedrive/refresh-token"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "onedrive_token_expiry" {
  name  = "/petroglyph/onedrive/token-expiry"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "graph_subscription_id" {
  name  = "/petroglyph/graph/subscription-id"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "config_target_branch" {
  name  = "/petroglyph/config/target-branch"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "config_initial_sync" {
  name  = "/petroglyph/config/initial-sync"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "config_retention_days" {
  name  = "/petroglyph/config/retention-days"
  type  = "SecureString"
  value = "90"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}
