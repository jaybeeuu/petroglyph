resource "aws_s3_bucket" "staged_pdfs" {
  bucket = "petroglyph-staged-pdfs-${terraform.workspace}"

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "staged_pdfs" {
  bucket = aws_s3_bucket.staged_pdfs.id

  rule {
    bucket_key_enabled = false

    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# The delivery surface hands the client a presigned S3 GET and the client fetches
# it directly. In Obsidian that fetch runs in the renderer, so it is a browser
# origin and S3 enforces CORS on it: without a rule the transfer never starts
# (petroglyph-alof). Signed HEAD/GET also have to expose the headers a client
# reads, or a range download cannot verify size or type.
#
# `*` is deliberate. The object is private and the signature is the capability,
# so a blanket origin grant reaches nothing an unsigned caller can get. An
# explicit origin list would pin today's Obsidian renderer origins
# (app://obsidian.md desktop, capacitor://localhost mobile) and break the next
# client; state the choice here so a later reader knows it was made, not missed.
resource "aws_s3_bucket_cors_configuration" "staged_pdfs" {
  bucket = aws_s3_bucket.staged_pdfs.id

  cors_rule {
    id              = "presigned-download"
    allowed_methods = ["GET", "HEAD"]
    allowed_headers = ["*"]
    allowed_origins = ["*"]
    expose_headers = [
      "ETag",
      "Content-Length",
      "Content-Type",
      "Content-Range",
      "Accept-Ranges",
    ]
    # Keep a client from caching a policy we may tighten later.
    max_age_seconds = 300
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
