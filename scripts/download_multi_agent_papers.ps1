[CmdletBinding()]
param(
    [string]$Destination = "docs/researches_and_papers"
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$destPath = Join-Path (Get-Location) $Destination
New-Item -ItemType Directory -Force -Path $destPath | Out-Null

$papers = @(
    @{
        FileName = "2023-03 - CAMEL - Communicative Agents for Mind Exploration of Large Language Model Society.pdf"
        Title = "CAMEL: Communicative Agents for Mind Exploration of Large Language Model Society"
        Url = "https://arxiv.org/pdf/2303.17760.pdf"
    },
    @{
        FileName = "2023-07 - ChatDev - Communicative Agents for Software Development.pdf"
        Title = "ChatDev: Communicative Agents for Software Development"
        Url = "https://aclanthology.org/2024.acl-long.810.pdf"
    },
    @{
        FileName = "2023-08 - A Survey on Large Language Model Based Autonomous Agents.pdf"
        Title = "A Survey on Large Language Model Based Autonomous Agents"
        Url = "https://journal.hep.com.cn/fcs/EN/PDF/10.1007/s11704-024-40231-1"
    },
    @{
        FileName = "2023-08 - AutoGen - Enabling Next-Gen LLM Applications via Multi-Agent Conversation.pdf"
        Title = "AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation"
        Url = "https://arxiv.org/pdf/2308.08155.pdf"
    },
    @{
        FileName = "2023-08 - MetaGPT - Meta Programming for a Multi-Agent Collaborative Framework.pdf"
        Title = "MetaGPT: Meta Programming for a Multi-Agent Collaborative Framework"
        Url = "https://arxiv.org/pdf/2308.00352.pdf"
    },
    @{
        FileName = "2024-02 - AgentScope - A Flexible Yet Robust Multi-Agent Platform.pdf"
        Title = "AgentScope: A Flexible Yet Robust Multi-Agent Platform"
        Url = "https://arxiv.org/pdf/2402.14034.pdf"
    },
    @{
        FileName = "2024-02 - Large Language Model Based Multi-Agents - A Survey of Progress and Challenges.pdf"
        Title = "Large Language Model Based Multi-Agents: A Survey of Progress and Challenges"
        Url = "https://www.ijcai.org/proceedings/2024/0890.pdf"
    },
    @{
        FileName = "2024-10 - A Survey on LLM-Based Multi-Agent Systems - Workflow, Infrastructure, and Challenges.pdf"
        Title = "A Survey on LLM-Based Multi-Agent Systems: Workflow, Infrastructure, and Challenges"
        Url = "https://link.springer.com/content/pdf/10.1007/s44336-024-00009-2.pdf"
    },
    @{
        FileName = "2024-11 - Magentic-One - A Generalist Multi-Agent System for Solving Complex Tasks.pdf"
        Title = "Magentic-One: A Generalist Multi-Agent System for Solving Complex Tasks"
        Url = "https://arxiv.org/pdf/2411.04468.pdf"
    },
    @{
        FileName = "2025-01 - Multi-Agent Collaboration Mechanisms - A Survey of LLMs.pdf"
        Title = "Multi-Agent Collaboration Mechanisms: A Survey of LLMs"
        Url = "https://arxiv.org/pdf/2501.06322.pdf"
    },
    @{
        FileName = "2025-03 - MultiAgentBench - Evaluating the Collaboration and Competition of LLM Agents.pdf"
        Title = "MultiAgentBench: Evaluating the Collaboration and Competition of LLM Agents"
        Url = "https://aclanthology.org/2025.acl-long.421.pdf"
    },
    @{
        FileName = "2025-03 - Why Do Multi-Agent LLM Systems Fail.pdf"
        Title = "Why Do Multi-Agent LLM Systems Fail?"
        Url = "https://arxiv.org/pdf/2503.13657.pdf"
    },
    @{
        FileName = "2025-04 - Which Agent Causes Task Failures and When - On Automated Failure Attribution of LLM Multi-Agent Systems.pdf"
        Title = "Which Agent Causes Task Failures and When? On Automated Failure Attribution of LLM Multi-Agent Systems"
        Url = "https://arxiv.org/pdf/2505.00212.pdf"
    },
    @{
        FileName = "2025-05 - Multi-Agent Collaboration via Evolving Orchestration.pdf"
        Title = "Multi-Agent Collaboration via Evolving Orchestration"
        Url = "https://openreview.net/pdf?id=L0xZPXT3le"
    },
    @{
        FileName = "2026-05 - Agent Harness Engineering - A Survey.pdf"
        Title = "Agent Harness Engineering: A Survey"
        Url = "https://picrew.github.io/LLM-Harness/main.pdf"
    }
)

$failures = New-Object System.Collections.Generic.List[object]

foreach ($paper in $papers) {
    $target = Join-Path $destPath $paper.FileName
    Write-Host "Downloading $($paper.FileName)"

    try {
        Invoke-WebRequest -Uri $paper.Url -OutFile $target -UseBasicParsing -MaximumRedirection 5
    } catch {
        $failures.Add([PSCustomObject]@{
            FileName = $paper.FileName
            Title = $paper.Title
            Url = $paper.Url
            Error = $_.Exception.Message
        })
    }
}

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "Download failures:"
    $failures | Format-Table -AutoSize
    exit 1
}

Write-Host ""
Write-Host "Downloaded papers:"
Get-ChildItem -Path $destPath -File |
    Sort-Object Name |
    Select-Object Name, Length |
    Format-Table -AutoSize
