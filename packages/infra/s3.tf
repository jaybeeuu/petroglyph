resource "aws_s3_bucket" "staged_pdfs" {
  bucket = "petroglyph-staged-pdfs-${terraform.workspace}"

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "staged_pdfs" {
  bucket = aws_s3_bucket.staged_pdfs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "staged_pdfs" {
  bucket = aws_s3_bucket.staged_pdfs.id

  rule {
    id     = "expire-staged-pdfs"
    status = "Enabled"

    expiration {
      days = var.retention_days
    }
  }
}
