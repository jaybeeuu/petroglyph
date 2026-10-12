locals {
  # SSM parameters are namespaced by workspace so a second workspace (qa) cannot
  # collide with production. Resource names embed the workspace the same way
  # (petroglyph-<thing>-${terraform.workspace}); this brings SSM in line.
  ssm_parameter_prefix = "/petroglyph/${terraform.workspace}"
}

provider "aws" {
  region = "eu-west-2"

  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  skip_requesting_account_id  = true
}
