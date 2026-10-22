use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ExitDecision {
    Allow,
    Confirm,
    KeepOpen,
}

pub(crate) fn request_exit(has_active_tasks: bool, prompt_open: &AtomicBool) -> ExitDecision {
    if !has_active_tasks {
        ExitDecision::Allow
    } else if prompt_open.swap(true, Ordering::AcqRel) {
        ExitDecision::KeepOpen
    } else {
        ExitDecision::Confirm
    }
}

pub(crate) fn continue_waiting(prompt_open: &AtomicBool) {
    prompt_open.store(false, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    #[test]
    fn an_idle_application_closes_without_reserving_a_dialog() {
        let prompt_open = AtomicBool::new(false);
        assert_eq!(request_exit(false, &prompt_open), ExitDecision::Allow);
        assert!(!prompt_open.load(Ordering::Acquire));
    }

    #[test]
    fn simultaneous_window_and_application_exit_requests_open_only_one_dialog() {
        let prompt_open = Arc::new(AtomicBool::new(false));
        let requests = (0..8)
            .map(|_| {
                let prompt_open = prompt_open.clone();
                std::thread::spawn(move || request_exit(true, &prompt_open))
            })
            .collect::<Vec<_>>();
        let decisions = requests
            .into_iter()
            .map(|request| request.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            decisions
                .iter()
                .filter(|d| **d == ExitDecision::Confirm)
                .count(),
            1
        );
        assert_eq!(
            decisions
                .iter()
                .filter(|d| **d == ExitDecision::KeepOpen)
                .count(),
            7
        );
    }

    #[test]
    fn continuing_work_allows_a_later_exit_confirmation() {
        let prompt_open = AtomicBool::new(false);
        assert_eq!(request_exit(true, &prompt_open), ExitDecision::Confirm);
        continue_waiting(&prompt_open);
        assert_eq!(request_exit(true, &prompt_open), ExitDecision::Confirm);
    }

    #[test]
    fn cancellation_keeps_application_open_until_tasks_are_terminal() {
        let prompt_open = AtomicBool::new(false);
        assert_eq!(request_exit(true, &prompt_open), ExitDecision::Confirm);
        // 发出取消请求仍可能在回滚或确认提交，活动状态必须继续阻止退出。
        assert_eq!(request_exit(true, &prompt_open), ExitDecision::KeepOpen);
        assert_eq!(request_exit(true, &prompt_open), ExitDecision::KeepOpen);
        assert_eq!(request_exit(false, &prompt_open), ExitDecision::Allow);
    }
}
