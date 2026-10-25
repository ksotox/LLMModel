use std::io::Write;

use anyhow::{Result, bail};
use async_trait::async_trait;
use isideload::{
    auth::apple_account::{TwoFactorCallbackParams, TwoFactorCallbackResponse},
    dev::{certificates::DevelopmentCertificate, teams::DeveloperTeam},
};
use sideward_core::Prompter;

/// Answers login/signing questions on the terminal.
pub struct CliPrompter {
    /// When false (e.g. `daemon`), any question is an error instead of blocking forever.
    pub interactive: bool,
}

async fn read_line(prompt: String) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        print!("{prompt}");
        std::io::stdout().flush()?;
        let mut line = String::new();
        if std::io::stdin().read_line(&mut line)? == 0 {
            bail!("No input (stdin closed)");
        }
        Ok(line.trim().to_string())
    })
    .await?
}

pub async fn read_password(prompt: &str) -> Result<String> {
    let prompt = prompt.to_string();
    Ok(tokio::task::spawn_blocking(move || rpassword::prompt_password(prompt)).await??)
}

pub async fn ask(prompt: &str) -> Result<String> {
    read_line(prompt.to_string()).await
}

impl CliPrompter {
    fn ensure_interactive(&self, what: &str) -> Result<()> {
        if !self.interactive {
            bail!("{what} needs your input; run `sideward login` interactively first");
        }
        Ok(())
    }
}

#[async_trait]
impl Prompter for CliPrompter {
    async fn two_factor(
        &self,
        params: TwoFactorCallbackParams,
    ) -> Result<TwoFactorCallbackResponse> {
        self.ensure_interactive("Two-factor authentication")?;
        if let Some(err) = &params.last_error {
            eprintln!("  {err}");
        }
        let target = if params.sms {
            params
                .numbers
                .iter()
                .find(|n| Some(n.id) == params.selected_number_id)
                .map(|n| n.number_with_dial_code.clone())
                .unwrap_or_else(|| "your phone".into())
        } else {
            "your trusted devices".into()
        };
        if params.unknown {
            println!("The last 2FA method didn't work. Choose another:");
        } else {
            println!("A verification code was sent to {target}.");
        }
        let others: Vec<_> = params
            .numbers
            .iter()
            .filter(|n| Some(n.id) != params.selected_number_id)
            .collect();
        if params.sms || params.unknown {
            println!("  d       send the code to your devices instead");
        }
        for n in &others {
            println!(
                "  p{}      text the code to {}",
                n.id, n.number_with_dial_code
            );
        }
        if !params.unknown {
            println!("  r       resend the code");
        }
        println!("  q       cancel");
        loop {
            let answer = read_line("Code: ".into()).await?;
            match answer.as_str() {
                "q" => return Ok(TwoFactorCallbackResponse::Abort),
                "d" => return Ok(TwoFactorCallbackResponse::SendToDevices),
                "r" if !params.unknown => return Ok(TwoFactorCallbackResponse::ResendCode),
                a if a.starts_with('p') => match a[1..].parse::<u32>() {
                    Ok(id) => return Ok(TwoFactorCallbackResponse::SendSms(id)),
                    Err(_) => println!("Type p followed by the number id, e.g. p1"),
                },
                a if a.len() == 6 && a.chars().all(|c| c.is_ascii_digit()) => {
                    return Ok(TwoFactorCallbackResponse::SubmitCode(a.to_string()));
                }
                _ => println!("Enter the 6-digit code, or one of the options above."),
            }
        }
    }

    async fn select_team(&self, teams: &[DeveloperTeam]) -> Result<Option<String>> {
        self.ensure_interactive("Choosing a developer team")?;
        println!("This Apple ID belongs to several teams:");
        for (i, t) in teams.iter().enumerate() {
            println!(
                "  {}) {} ({})",
                i + 1,
                t.name.as_deref().unwrap_or("Unnamed"),
                t.team_id
            );
        }
        let answer = read_line("Team number: ".into()).await?;
        Ok(answer
            .parse::<usize>()
            .ok()
            .and_then(|n| teams.get(n.checked_sub(1)?))
            .map(|t| t.team_id.clone()))
    }

    async fn revoke_certificates(
        &self,
        certs: Vec<DevelopmentCertificate>,
    ) -> Result<Option<Vec<String>>> {
        self.ensure_interactive("Revoking a certificate")?;
        println!("Your account has the maximum number of development certificates.");
        println!("Revoking one stops apps signed with it from opening until they're reinstalled.");
        for (i, c) in certs.iter().enumerate() {
            println!(
                "  {}) {} on {} (serial {})",
                i + 1,
                c.name.as_deref().unwrap_or("Certificate"),
                c.machine_name.as_deref().unwrap_or("unknown machine"),
                c.serial_number.as_deref().unwrap_or("?")
            );
        }
        let answer =
            read_line("Numbers to revoke (comma-separated, empty to cancel): ".into()).await?;
        let serials: Vec<String> = answer
            .split(',')
            .filter_map(|s| s.trim().parse::<usize>().ok())
            .filter_map(|n| certs.get(n.checked_sub(1)?))
            .filter_map(|c| c.serial_number.clone())
            .collect();
        Ok((!serials.is_empty()).then_some(serials))
    }
}
