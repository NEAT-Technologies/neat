resource "aws_db_instance" "main" {
  identifier = "app-db"
  engine     = "postgres"
}

resource "aws_security_group" "db" {
  name = "app-db-sg"
}

# The app server references the RDS instance and its security group, so both
# are in use — something in the topology points at them.
resource "aws_instance" "app" {
  ami                    = "ami-fixture"
  instance_type          = "t3.micro"
  vpc_security_group_ids = [aws_security_group.db.id]
  user_data              = "DATABASE_URL=${aws_db_instance.main.endpoint}"
}

# Nothing references this bucket — it is declared-but-unused, and stays an
# edgeless orphan so the two cases remain distinguishable.
resource "aws_s3_bucket" "orphan" {
  bucket = "fixture-orphan"
}
