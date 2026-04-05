terraform {
  backend "s3" {
    bucket         = "petroglyph-terraform-state"
    key            = "petroglyph/terraform.tfstate"
    region         = "eu-west-2"
    dynamodb_table = "petroglyph-terraform-locks"
    encrypt        = true
  }
}
