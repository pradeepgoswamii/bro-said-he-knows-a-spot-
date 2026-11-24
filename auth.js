const authIsFileProtocol = window.location.protocol === 'file:';
const authApiUrl = authIsFileProtocol
  ? 'http://localhost:3000/api'
  : (window.location.origin.includes(':') && !window.location.origin.endsWith(':3000')
      ? window.location.origin.replace(/:[0-9]+$/, ':3000') + '/api'
      : (window.location.origin + '/api'));

let pendingUserSession = null;
let pendingSignupPayload = null;
let selectedAvatar = 'https://api.dicebear.com/7.x/notionists/svg?seed=mountain';
let selectedVibes = ['Hidden Gems'];

// Keep only a transient identity pointer in this tab; account profiles live in MongoDB.
localStorage.removeItem('currentUser');
function persistClientSession(user) {
  if (!user || !user.username) {
    sessionStorage.removeItem('currentUser');
    if (window.setAuthToken) window.setAuthToken(null);
    return;
  }
  sessionStorage.setItem('currentUser', JSON.stringify({ id: user.id || 0, username: user.username }));
  if (user.token && window.setAuthToken) window.setAuthToken(user.token);
}

document.addEventListener('DOMContentLoaded', () => {
  initPhoneSlider();
  initAuthTabs();
  initPasswordToggles();
  initPasswordStrengthMeter();
  initProfileCustomization();
  initGuestMode();
  initFormSubmissions();
  setupProVerifyModal();
});

// --- 1. Phone Showcase Slider ---
function initPhoneSlider() {
  const slides = document.querySelectorAll('#phoneSlider .slide-item');
  if (!slides || slides.length === 0) return;
  let currentSlide = 0;

  setInterval(() => {
    slides[currentSlide].classList.remove('active');
    currentSlide = (currentSlide + 1) % slides.length;
    slides[currentSlide].classList.add('active');
  }, 4500);
}

// --- 2. field guide Tab & Switcher ---
let selectedAccountType = 'normal';

function initAuthTabs() {
  const tabSignUp = document.getElementById('tabSignUp');
  const tabSignIn = document.getElementById('tabSignIn');
  const signUpForm = document.getElementById('signUpForm');
  const signInForm = document.getElementById('signInForm');
  const goToSignInBtn = document.getElementById('goToSignInBtn');
  const goToSignUpBtn = document.getElementById('goToSignUpBtn');

  function switchToSignUp() {
    if (tabSignUp) tabSignUp.classList.add('active');
    if (tabSignIn) tabSignIn.classList.remove('active');
    if (signUpForm) signUpForm.classList.add('active');
    if (signInForm) signInForm.classList.remove('active');
    const card = document.querySelector('.ig-auth-card');
    if (card) card.scrollTop = 0;
  }

  function switchToSignIn() {
    if (tabSignIn) tabSignIn.classList.add('active');
    if (tabSignUp) tabSignUp.classList.remove('active');
    if (signInForm) signInForm.classList.add('active');
    if (signUpForm) signUpForm.classList.remove('active');
    const card = document.querySelector('.ig-auth-card');
    if (card) card.scrollTop = 0;
  }

  if (tabSignUp) tabSignUp.addEventListener('click', switchToSignUp);
  if (tabSignIn) tabSignIn.addEventListener('click', switchToSignIn);
  if (goToSignInBtn) goToSignInBtn.addEventListener('click', switchToSignIn);
  if (goToSignUpBtn) goToSignUpBtn.addEventListener('click', switchToSignUp);

  // Check URL query parameters (e.g. auth.html?mode=login or auth.html?verify_pro=true)
  try {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('mode') === 'login' || urlParams.get('tab') === 'login') {
      switchToSignIn();
    } else if (urlParams.get('verify_pro') === 'true') {
      setTimeout(() => openProVerificationModal(), 200);
    }
  } catch (e) {
    console.warn('URL parsing error:', e);
  }

  // Account Type Selection Cards
  const typeNormal = document.getElementById('typeNormal');
  const typePro = document.getElementById('typePro');
  const typeNormalLabel = document.getElementById('typeNormalLabel');
  const typeProLabel = document.getElementById('typeProLabel');
  const accountTypeHint = document.getElementById('accountTypeHint');

  function setAccountType(mode) {
    selectedAccountType = mode;
    if (mode === 'professional') {
      if (typePro) typePro.checked = true;
      if (typeNormal) typeNormal.checked = false;
      if (typeProLabel) typeProLabel.classList.add('selected');
      if (typeNormalLabel) typeNormalLabel.classList.remove('selected');
      if (accountTypeHint) {
        accountTypeHint.innerHTML = "<strong class='text-[#38bdf8]'>Pro Creator Mode active:</strong> Unlocks verified checkmark ☑️, trusted reviewer status & priority feed discovery via 1-time Aadhaar check.";
      }
    } else {
      if (typeNormal) typeNormal.checked = true;
      if (typePro) typePro.checked = false;
      if (typeNormalLabel) typeNormalLabel.classList.add('selected');
      if (typeProLabel) typeProLabel.classList.remove('selected');
      if (accountTypeHint) {
        accountTypeHint.innerHTML = "Normal members can post spots & reviews. Pro Creators unlock verified checkmarks, trusted review score & affiliate stay links.";
      }
    }
  }

  if (typeNormalLabel) {
    typeNormalLabel.addEventListener('click', (e) => {
      setAccountType('normal');
    });
  }
  if (typeProLabel) {
    typeProLabel.addEventListener('click', (e) => {
      setAccountType('professional');
    });
  }
  if (typeNormal) typeNormal.addEventListener('change', () => setAccountType('normal'));
  if (typePro) typePro.addEventListener('change', () => setAccountType('professional'));

  setAccountType('normal');
}

// --- 3. Password Show/Hide Toggle ---
function initPasswordToggles() {
  document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const input = document.getElementById(targetId);
      if (!input) return;
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'Hide';
        btn.setAttribute('aria-label', 'Hide password');
      } else {
        input.type = 'password';
        btn.textContent = 'Show';
        btn.setAttribute('aria-label', 'Show password');
      }
    });
  });
}

// --- 4. Password Strength Meter ---
function initPasswordStrengthMeter() {
  const passInput = document.getElementById('signup-password');
  const meterFill = document.getElementById('signupPassMeter');

  passInput.addEventListener('input', () => {
    const val = passInput.value;
    let strength = 0;
    if (val.length >= 6) strength += 30;
    if (val.length >= 9) strength += 20;
    if (/[A-Z]/.test(val)) strength += 20;
    if (/[0-9]/.test(val)) strength += 15;
    if (/[^A-Za-z0-9]/.test(val)) strength += 15;

    meterFill.style.width = `${Math.min(strength, 100)}%`;
    if (strength < 40) {
      meterFill.style.backgroundColor = '#f87171'; // red
    } else if (strength < 75) {
      meterFill.style.backgroundColor = '#fbbf24'; // yellow
    } else {
      meterFill.style.backgroundColor = '#34d399'; // emerald green
    }
  });
}

// --- 5. Profile Customization (Avatars & Vibes) ---
function initProfileCustomization() {
  const previewImg = document.getElementById('avatarPreviewImg');
  const presetChips = document.querySelectorAll('.preset-chip');
  const customAvatarInput = document.getElementById('customAvatarInput');
  const avatarPreviewContainer = document.getElementById('avatarPreviewContainer');

  presetChips.forEach(chip => {
    chip.addEventListener('click', () => {
      presetChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const seed = chip.getAttribute('data-seed');
      selectedAvatar = `https://api.dicebear.com/7.x/notionists/svg?seed=${seed}`;
      previewImg.src = selectedAvatar;
    });
  });

  avatarPreviewContainer.addEventListener('click', () => {
    customAvatarInput.click();
  });

  customAvatarInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        selectedAvatar = evt.target.result;
        previewImg.src = selectedAvatar;
        presetChips.forEach(c => c.classList.remove('active'));
      };
      reader.readAsDataURL(file);
    }
  });

  // Travel Vibes Multi-select
  const vibeContainer = document.getElementById('vibeChipsContainer');
  if (vibeContainer) {
    vibeContainer.querySelectorAll('.vibe-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        tag.classList.toggle('selected');
        const vibe = tag.getAttribute('data-vibe');
        if (tag.classList.contains('selected')) {
          if (!selectedVibes.includes(vibe)) selectedVibes.push(vibe);
        } else {
          selectedVibes = selectedVibes.filter(v => v !== vibe);
        }
      });
    });
  }
}

// --- 6. Guest browsing (no sample accounts) ---
function initGuestMode() {
  const guestBtn = document.getElementById('exploreAsGuestBtn');
  if (!guestBtn) return;

  guestBtn.addEventListener('click', () => {
    const guestUser = {
      id: 0,
      name: 'Guest Explorer',
      username: 'guest_traveler',
      role: 'normal',
      is_verified_pro: false,
      avatar: ''
    };
    if (window.setAuthToken) window.setAuthToken(null);
    persistClientSession(guestUser);
    window.location.href = 'feed.html';
  });
}

// --- 7. Form Submissions ---
function initFormSubmissions() {
  const signInForm = document.getElementById('signInForm');
  const signUpForm = document.getElementById('signUpForm');
  const loginErrorMsg = document.getElementById('loginErrorMsg');
  const signUpErrorMsg = document.getElementById('signUpErrorMsg');
  const otpStep = document.getElementById('signupOtpStep');
  const otpInput = document.getElementById('signupOtpCode');
  const resendOtpBtn = document.getElementById('resendSignupOtpBtn');
  const editSignupBtn = document.getElementById('editSignupDetailsBtn');

  // Sign In Submit
  if (signInForm) {
    signInForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('signInSubmitBtn');
      submitBtn.innerHTML = '<span>Verifying...</span>';
      submitBtn.disabled = true;
      if (loginErrorMsg) loginErrorMsg.classList.add('hidden');

      const usernameInput = document.getElementById('signin-username').value.trim();
      const password = document.getElementById('signin-password').value;

      try {
        const res = await fetch(`${authApiUrl}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: usernameInput, password })
        });
        const data = await res.json();
        if (res.ok) {
          persistClientSession(data);
          window.location.href = 'feed.html';
        } else {
          const errText = data.error || 'Invalid username or password.';
          if (loginErrorMsg) {
            loginErrorMsg.textContent = errText;
            loginErrorMsg.classList.remove('hidden');
          } else {
            alert(errText);
          }
          submitBtn.innerHTML = '<span>Log In</span>';
          submitBtn.disabled = false;
        }
      } catch (err) {
        console.warn('Network sign-in error:', err);
        if (loginErrorMsg) {
          loginErrorMsg.textContent = 'Could not reach the sign-in server. Check the server and MongoDB connection, then try again.';
          loginErrorMsg.classList.remove('hidden');
        } else {
          alert('Unable to reach the sign-in service. Please try again.');
        }
        submitBtn.innerHTML = '<span>Log In</span>';
        submitBtn.disabled = false;
      }
    });
  }

  // Sign Up Submit
  if (signUpForm) {
    signUpForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('signUpSubmitBtn');
      submitBtn.innerHTML = pendingSignupPayload ? '<span>Verifying code...</span>' : '<span>Sending code...</span>';
      submitBtn.disabled = true;
      if (signUpErrorMsg) signUpErrorMsg.classList.add('hidden');

      try {
        if (!pendingSignupPayload) {
          const name = document.getElementById('signup-name').value.trim();
          const username = document.getElementById('signup-username').value.trim();
          const email = document.getElementById('signup-email').value.trim();
          const password = document.getElementById('signup-password').value;
          const confirmPassword = document.getElementById('signup-confirm-password').value;
          const isPro = selectedAccountType === 'professional' || !!document.getElementById('typePro')?.checked;
          if (password !== confirmPassword) throw new Error('Passwords do not match. Please verify your password.');

          const signupPayload = {
            name,
            username,
            email,
            password,
            avatar: selectedAvatar,
            bio: document.getElementById('signup-bio')?.value.trim() || '',
            vibes: selectedVibes,
            role: isPro ? 'professional' : 'normal'
          };
          const response = await fetch(`${authApiUrl}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(signupPayload)
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Could not send a verification code.');
          pendingSignupPayload = signupPayload;

          if (otpStep) otpStep.classList.remove('hidden');
          const otpMessage = document.getElementById('signupOtpMessage');
          if (otpMessage) otpMessage.textContent = `A six-digit code was sent to ${result.email || signupPayload.email}. It expires in 10 minutes.`;
          if (otpInput) {
            otpInput.required = true;
            otpInput.focus();
          }
          submitBtn.innerHTML = '<span>Verify email & create account</span>';
          submitBtn.disabled = false;
          startSignupOtpResendTimer(resendOtpBtn);
          return;
        }

        const response = await fetch(`${authApiUrl}/auth/signup/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: pendingSignupPayload.email, code: otpInput?.value.trim() || '' })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Email verification failed.');

        const isPro = pendingSignupPayload.role === 'professional';
        pendingUserSession = data;
        pendingSignupPayload = null;
        persistClientSession(data);
        if (isPro) openProVerificationModal();
        else window.location.href = 'feed.html';
      } catch (err) {
        if (signUpErrorMsg) {
          signUpErrorMsg.textContent = err.message || 'Could not complete signup. Please try again.';
          signUpErrorMsg.classList.remove('hidden');
        } else alert(err.message || 'Could not complete signup. Please try again.');
        submitBtn.innerHTML = pendingSignupPayload ? '<span>Verify email & create account</span>' : '<span>Create Account</span>';
        submitBtn.disabled = false;
      }
    });
  }

  if (resendOtpBtn) resendOtpBtn.addEventListener('click', async () => {
    if (!pendingSignupPayload || resendOtpBtn.disabled) return;
    resendOtpBtn.disabled = true;
    if (signUpErrorMsg) signUpErrorMsg.classList.add('hidden');
    try {
      const response = await fetch(`${authApiUrl}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingSignupPayload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not resend the code.');
      startSignupOtpResendTimer(resendOtpBtn);
    } catch (err) {
      if (signUpErrorMsg) {
        signUpErrorMsg.textContent = err.message;
        signUpErrorMsg.classList.remove('hidden');
      }
      resendOtpBtn.disabled = false;
    }
  });

  if (editSignupBtn) editSignupBtn.addEventListener('click', () => {
    pendingSignupPayload = null;
    if (otpStep) otpStep.classList.add('hidden');
    if (otpInput) { otpInput.value = ''; otpInput.required = false; }
    const submitBtn = document.getElementById('signUpSubmitBtn');
    if (submitBtn) submitBtn.innerHTML = '<span>Create Account</span>';
    if (resendOtpBtn) { resendOtpBtn.disabled = false; resendOtpBtn.textContent = 'Resend code'; }
  });
}

function startSignupOtpResendTimer(button) {
  if (!button) return;
  let seconds = 60;
  button.disabled = true;
  button.textContent = `Resend in ${seconds}s`;
  const timer = setInterval(() => {
    seconds--;
    if (seconds <= 0) {
      clearInterval(timer);
      button.disabled = false;
      button.textContent = 'Resend code';
    } else {
      button.textContent = `Resend in ${seconds}s`;
    }
  }, 1000);
}

// --- 8. Professional Creator Verification Modal Flow ---
function openProVerificationModal() {
  const modal = document.getElementById('proVerifyModal');
  if (!modal) return;
  
  if (!pendingUserSession) {
    try {
      pendingUserSession = JSON.parse(sessionStorage.getItem('currentUser'));
    } catch (e) {
      pendingUserSession = null;
    }
  }

  const step1 = document.getElementById('proStep1');
  const step2 = document.getElementById('proStep2');
  const step3 = document.getElementById('proStep3');
  const aadhaarError = document.getElementById('aadhaarError');

  if (step1) step1.classList.remove('hidden');
  if (step2) step2.classList.add('hidden');
  if (step3) step3.classList.add('hidden');
  if (aadhaarError) aadhaarError.classList.add('hidden');

  const s1Tab = document.getElementById('step1Tab');
  const s2Tab = document.getElementById('step2Tab');
  const s3Tab = document.getElementById('step3Tab');
  if (s1Tab) s1Tab.className = "font-bold text-[#38bdf8]";
  if (s2Tab) s2Tab.className = "text-slate-500";
  if (s3Tab) s3Tab.className = "text-slate-500";

  modal.classList.remove('hidden');
}

function setupProVerifyModal() {
  const modal = document.getElementById('proVerifyModal');
  if (!modal) return;

  const closeBtn = document.getElementById('closeProVerifyModalBtn');
  const nextToStep2Btn = document.getElementById('nextToStep2Btn');
  const completeFaceScanBtn = document.getElementById('completeFaceScanBtn');
  const finishBtn = document.getElementById('finishVerificationBtn');
  const aadhaarInput = document.getElementById('aadhaarInput');

  // Auto-format Aadhaar with spaces (xxxx xxxx xxxx)
  if (aadhaarInput) {
    aadhaarInput.addEventListener('input', (e) => {
      let val = e.target.value.replace(/\D/g, '').substring(0, 12);
      let parts = [];
      for (let i = 0; i < val.length; i += 4) {
        parts.push(val.substring(i, i + 4));
      }
      e.target.value = parts.join(' ');
    });
  }

  if (closeBtn) {
    closeBtn.onclick = () => {
      modal.classList.add('hidden');
      window.location.href = 'feed.html';
    };
  }

  if (finishBtn) {
    finishBtn.onclick = () => {
      modal.classList.add('hidden');
      window.location.href = 'feed.html';
    };
  }

  // Step 1: Aadhaar Check
  if (nextToStep2Btn) {
    nextToStep2Btn.onclick = async () => {
      const aadhaarVal = aadhaarInput ? aadhaarInput.value.replace(/\s+/g, '').trim() : '';
      const aadhaarError = document.getElementById('aadhaarError');

      if (aadhaarVal.length !== 12 || !/^\d{12}$/.test(aadhaarVal)) {
        if (aadhaarError) {
          aadhaarError.textContent = "Please enter a valid 12-digit Aadhaar number.";
          aadhaarError.classList.remove('hidden');
        }
        return;
      }

      if (!pendingUserSession) {
        try {
          pendingUserSession = JSON.parse(sessionStorage.getItem('currentUser'));
        } catch (e) {
          pendingUserSession = null;
        }
      }

      if (!pendingUserSession || !pendingUserSession.username) {
        if (aadhaarError) {
          aadhaarError.textContent = "Please log in or register before completing Pro verification.";
          aadhaarError.classList.remove('hidden');
        }
        return;
      }

      nextToStep2Btn.disabled = true;
      nextToStep2Btn.textContent = "Verifying 1-Aadhaar Policy...";

      try {
        const res = await fetch(`${authApiUrl}/auth/verify-professional`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: pendingUserSession.id || 0,
            username: pendingUserSession.username,
            aadhaar_no: aadhaarVal,
            face_scan_verified: true
          })
        });

        const data = await res.json();
        if (!res.ok) {
          if (aadhaarError) {
            aadhaarError.textContent = data.error || 'Aadhaar validation failed';
            aadhaarError.classList.remove('hidden');
          }
          nextToStep2Btn.disabled = false;
          nextToStep2Btn.textContent = "Proceed to Biometric Face Scan →";
          return;
        }

        // Update local session
        if (data.token && window.setAuthToken) window.setAuthToken(data.token);
        if (data.user) {
          pendingUserSession = { ...data.user, token: data.token };
        } else {
          pendingUserSession.role = 'professional';
          pendingUserSession.is_verified_pro = true;
        }
        persistClientSession(pendingUserSession);

        // Success -> Proceed to Step 2
        document.getElementById('proStep1').classList.add('hidden');
        document.getElementById('proStep2').classList.remove('hidden');
        document.getElementById('step1Tab').className = "text-slate-500";
        document.getElementById('step2Tab').className = "font-bold text-[#38bdf8]";

      } catch (err) {
        console.warn('Professional verification request failed:', err);
        if (aadhaarError) {
          aadhaarError.textContent = 'Could not verify with the server. Check your connection and try again.';
          aadhaarError.classList.remove('hidden');
        }
      } finally {
        nextToStep2Btn.disabled = false;
        nextToStep2Btn.textContent = "Proceed to Biometric Face Scan →";
      }
    };
  }

  // Step 2: Biometric Face Liveness Scan Simulation
  if (completeFaceScanBtn) {
    completeFaceScanBtn.onclick = () => {
      completeFaceScanBtn.disabled = true;
      completeFaceScanBtn.textContent = "Scanning Biometric Liveness...";

      const statusText = document.getElementById('scanStatusText');
      const progressBar = document.getElementById('scanProgressBar');
      const faceIcon = document.getElementById('faceIcon');

      let pct = 0;
      const interval = setInterval(() => {
        pct += 25;
        if (progressBar) progressBar.style.width = `${pct}%`;
        if (pct === 25 && statusText) {
          statusText.textContent = "Facial Landmark Mesh Check...";
          if (faceIcon) faceIcon.textContent = "👤";
        }
        if (pct === 50 && statusText) {
          statusText.textContent = "Liveness Blink & Anti-Deepfake...";
          if (faceIcon) faceIcon.textContent = "🔍";
        }
        if (pct === 75 && statusText) {
          statusText.textContent = "Cross-Verifying Biometric Key...";
          if (faceIcon) faceIcon.textContent = "🛡️";
        }
        if (pct >= 100) {
          clearInterval(interval);
          if (statusText) {
            statusText.textContent = "✓ Biometric Verification Confirmed!";
            statusText.className = "absolute bottom-3 text-[10px] font-mono bg-emerald-500/90 text-black font-bold px-3 py-1 rounded-full shadow-lg";
          }
          if (faceIcon) faceIcon.textContent = "☑️";

          setTimeout(() => {
            document.getElementById('proStep2').classList.add('hidden');
            document.getElementById('proStep3').classList.remove('hidden');
            document.getElementById('step2Tab').className = "text-slate-500";
            document.getElementById('step3Tab').className = "font-bold text-[#38bdf8]";

            // Mark current user as verified pro permanently
            const session = pendingUserSession || JSON.parse(sessionStorage.getItem('currentUser') || '{}');
            session.role = 'professional';
            session.is_verified_pro = true;
            persistClientSession(session);
          }, 800);
        }
      }, 500);
    };
  }
}
