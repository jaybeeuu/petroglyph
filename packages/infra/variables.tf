variable "api_zip_s3_bucket" {
  description = "S3 bucket containing the API Lambda deployment zip"
  type        = string
}

variable "api_zip_s3_key" {
  description = "S3 key of the API Lambda deployment zip"
  type        = string
}

variable "ingest_onedrive_zip_s3_bucket" {
  description = "S3 bucket containing the ingest-onedrive Lambda deployment zip. Empty string disables the Lambda."
  type        = string
  default     = ""
}

variable "ingest_onedrive_zip_s3_key" {
  description = "S3 key of the ingest-onedrive Lambda deployment zip. Empty string disables the Lambda."
  type        = string
  default     = ""
}

variable "processor_zip_s3_bucket" {
  description = "S3 bucket containing the processor Lambda deployment zip. Empty string disables the Lambda."
  type        = string
  default     = ""
}

variable "processor_zip_s3_key" {
  description = "S3 key of the processor Lambda deployment zip. Empty string disables the Lambda."
  type        = string
  default     = ""
}

variable "sync_worker_zip_s3_bucket" {
  description = "S3 bucket containing the sync-worker Lambda deployment zip. Empty string disables the Lambda."
  type        = string
  default     = ""
}

variable "sync_worker_zip_s3_key" {
  description = "S3 key of the sync-worker Lambda deployment zip. Empty string disables the Lambda."
  type        = string
  default     = ""
}

variable "sync_relay_zip_s3_bucket" {
  description = "S3 bucket containing the sync-relay Lambda deployment zip. Empty string disables the Lambda."
  type        = string
  default     = ""
}

variable "sync_relay_zip_s3_key" {
  description = "S3 key of the sync-relay Lambda deployment zip. Empty string disables the Lambda."
  type        = string
  default     = ""
}

variable "forwarder_zip_s3_bucket" {
  description = "S3 bucket containing the staging forwarder Lambda deployment zip. Empty string disables the Lambda."
  type        = string
  default     = ""
}

variable "forwarder_zip_s3_key" {
  description = "S3 key of the staging forwarder Lambda deployment zip. Empty string disables the Lambda."
  type        = string
  default     = ""
}

variable "staging_delivery_zip_s3_bucket" {
  description = "S3 bucket containing the staging delivery Lambda deployment zip. Empty string disables the Lambda."
  type        = string
  default     = ""
}

variable "staging_delivery_zip_s3_key" {
  description = "S3 key of the staging delivery Lambda deployment zip. Empty string disables the Lambda."
  type        = string
  default     = ""
}

variable "graph_stub_zip_s3_bucket" {
  description = "S3 bucket containing the QA Graph stub Lambda deployment zip. Empty string disables the stub (production)."
  type        = string
  default     = ""
}

variable "graph_stub_zip_s3_key" {
  description = "S3 key of the QA Graph stub Lambda deployment zip. Empty string disables the stub."
  type        = string
  default     = ""
}

variable "api_custom_domain" {
  description = "Custom domain name for the API (e.g. api.petroglyph.page). Empty string disables custom domain resources."
  type        = string
  default     = ""
}

variable "graph_base_url" {
  description = "Microsoft Graph base URL the adapter calls. The deployed smoke points this (and the derived delta URL) at the QA Graph stub; production leaves it at the real Graph endpoint."
  type        = string
  default     = "https://graph.microsoft.com/v1.0"
}

# Number of days before staged PDF objects are expired by the S3 lifecycle rule.
# This variable is the source of truth: it is passed to the lifecycle rule at plan
# time, so changing it takes a `terraform apply`.
variable "retention_days" {
  description = "Number of days after which staged PDF objects are expired"
  type        = number
  default     = 90
}

variable "qa_quiesced" {
  description = <<-EOT
    Disable the QA workspace's SQS event source mappings so an idle QA issues no
    SQS requests. A Lambda SQS poller long-polls its queue whether or not a
    message exists, and every empty receive is a billed request: idle QA alone
    measured ~937,000 empty receives a month. QA is quiesced except while CI
    exercises it (the deploy applies with qa_quiesced=false, then re-applies the
    default). The variable is scoped to the `qa` workspace in the
    local.sqs_esm_enabled local, so it cannot affect production.
  EOT
  type        = bool
  default     = true
}
